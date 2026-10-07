'use server';

import { revalidatePath } from 'next/cache';
import { assertCan } from '@/core/permissions';
import { createCompanyAsPlatform } from '@/modules/platform';
import { getPlatformContext } from '@/modules/tenancy';
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
