'use server';

import { revalidatePath } from 'next/cache';
import { assertCan } from '@/core/permissions';
import { createCompanyAsPlatform, deleteCompanyAsPlatform, editCompanyAsPlatform, restoreCompanyAsPlatform, changeOwnerLoginAsPlatform } from '@/modules/platform';
import { confirmPassword, getPlatformContext } from '@/modules/tenancy';
import { done, fail, text } from '@/app/_lib/server-action';
import { requestOrigin } from '@/app/_lib/request-origin';
import type { ActionResult } from '@/components/action-result';

/**
 * A super admin creates a company (ADR-158). The company is set up as any company is, the super
 * admin does not become a member, and the owner either signs in with the password set here (ADR-160)
 * or joins through the invitation link shown once here — only its hash is stored (SECURITY_MODEL.md §3).
 */
export async function createCompanyAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await getPlatformContext();
  try {
    assertCan(ctx, 'platform.orgs.manage');
    const created = await createCompanyAsPlatform(ctx, {
      name: text(form, 'name'),
      countryCode: text(form, 'country_code'),
      baseCurrency: text(form, 'base_currency'),
      fiscalYearStartMonth: text(form, 'fiscal_year_start_month'),
      ownerEmail: text(form, 'owner_email'),
      // As typed: a password is never trimmed.
      ownerPassword: typeof form.get('owner_password') === 'string' ? (form.get('owner_password') as string) : '',
    });
    revalidatePath('/platform/organizations');
    if (created.invitationToken === null) {
      return done('Company created. The owner can sign in now with their email and the password you set.');
    }
    const origin = await requestOrigin();
    return done(`Company created. Send the owner this invitation link: ${origin}/invite/${created.invitationToken}`);
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'platform.createCompany' });
  }
}

/** Edit a company from the list (ADR-166). */
export async function editCompanyAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await getPlatformContext();
  try {
    assertCan(ctx, 'platform.orgs.manage');
    const orgId = text(form, 'org_id');
    await editCompanyAsPlatform(ctx, orgId, {
      name: text(form, 'name'),
      legalName: text(form, 'legal_name'),
      countryCode: text(form, 'country_code'),
      baseCurrency: text(form, 'base_currency'),
      fiscalYearStartMonth: text(form, 'fiscal_year_start_month'),
      plan: text(form, 'plan'),
    });
    // ADR-167: the owner's sign-in email and password, only when changed; it needs the super admin's own password.
    const raw = (name: string) => { const v = form.get(name); return typeof v === 'string' ? v : ''; };
    const newEmail = text(form, 'owner_email');
    const emailChanged = newEmail !== '' && newEmail.toLowerCase() !== text(form, 'owner_email_before').toLowerCase();
    let ownerEmail: string | null = null;
    if (emailChanged || raw('owner_password')) {
      await confirmPassword(ctx, raw('current_password'));
      ownerEmail = await changeOwnerLoginAsPlatform(ctx, orgId, { email: emailChanged ? newEmail : '', password: raw('owner_password') });
    }
    revalidatePath('/platform/organizations');
    revalidatePath(`/platform/organizations/${orgId}`);
    return done(ownerEmail ? `Saved. The owner now signs in as ${ownerEmail}${raw('owner_password') ? ' with the new password' : ''}; their open sessions were signed out.` : 'Saved.');
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'platform.editCompany' });
  }
}

/** Delete a company (ADR-166): scheduled, erased for good after thirty days, restorable until then. */
export async function deleteCompanyAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await getPlatformContext();
  try {
    assertCan(ctx, 'platform.orgs.manage');
    await deleteCompanyAsPlatform(ctx, text(form, 'org_id'));
    revalidatePath('/platform/organizations');
    return done('Deleted. Its data is erased for good in 30 days; until then you can restore it.');
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'platform.deleteCompany' });
  }
}

export async function restoreCompanyAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await getPlatformContext();
  try {
    assertCan(ctx, 'platform.orgs.manage');
    await restoreCompanyAsPlatform(ctx, text(form, 'org_id'));
    revalidatePath('/platform/organizations');
    return done('Restored.');
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'platform.restoreCompany' });
  }
}

