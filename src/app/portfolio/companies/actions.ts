'use server';

import { revalidatePath } from 'next/cache';
import { changeOwnerLogin, createCompany, setCompanyStatus } from '@/modules/platform';
import { getPortfolioContext } from '@/modules/portfolio';
import { done, fail, text } from '@/app/_lib/server-action';
import { requestOrigin } from '@/app/_lib/request-origin';
import type { ActionResult } from '@/components/action-result';

/**
 * A Financial Analyst's company actions (ADR-187). Each one is decided inside its `api.*` function:
 * an analyst acts only on a company they created or the super admin gave them.
 */

export async function createCompanyAsAnalystAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await getPortfolioContext();
  try {
    const created = await createCompany(ctx, {
      name: text(form, 'name'),
      countryCode: text(form, 'country_code'),
      baseCurrency: text(form, 'base_currency'),
      fiscalYearStartMonth: text(form, 'fiscal_year_start_month'),
      ownerEmail: text(form, 'owner_email'),
      // As typed: a password is never trimmed.
      ownerPassword: typeof form.get('owner_password') === 'string' ? (form.get('owner_password') as string) : '',
    });
    revalidatePath('/portfolio', 'layout');
    if (created.invitationToken === null) {
      return done('Company created. The owner can sign in now with their email and the password you set.');
    }
    const origin = await requestOrigin();
    return done(`Company created. Send the owner this invitation link: ${origin}/invite/${created.invitationToken}`);
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'analyst.createCompany' });
  }
}

export async function setCompanyStatusAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await getPortfolioContext();
  try {
    const active = text(form, 'status') === 'active';
    await setCompanyStatus(ctx, text(form, 'org_id'), active);
    revalidatePath('/portfolio', 'layout');
    return done(active ? 'Switched back on.' : 'Deactivated. Everyone in it sees only Home until you switch it back on.');
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'analyst.setCompanyStatus' });
  }
}

export async function changeOwnerLoginAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await getPortfolioContext();
  try {
    const raw = form.get('owner_password');
    const password = typeof raw === 'string' ? raw : '';
    const newEmail = text(form, 'owner_email');
    const emailChanged = newEmail.toLowerCase() !== text(form, 'owner_email_before').toLowerCase();
    const email = await changeOwnerLogin(ctx, text(form, 'org_id'), { email: emailChanged ? newEmail : '', password });
    revalidatePath('/portfolio/companies');
    return done(`Saved. The owner now signs in as ${email}${password ? ' with the new password' : ''}; their open sessions were signed out.`);
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'analyst.changeOwnerLogin' });
  }
}
