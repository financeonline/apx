'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { createOrganization, listMyOrganizations } from '@/modules/tenancy';
import { newRequestId } from '@/core/logging';
import { fail, text, integer } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

export async function createOrganizationAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const requestId = newRequestId();
  let slug: string | null = null;
  try {
    const db = await createUserClient();
    const organizationId = await createOrganization(
      db,
      {
        name: text(form, 'name'),
        countryCode: text(form, 'country_code') || 'GB',
        baseCurrency: text(form, 'base_currency') || 'GBP',
        fiscalYearStartMonth: integer(form, 'fiscal_year_start_month', 1),
        timezone: 'Europe/London',
      },
      requestId,
    );
    const organizations = await listMyOrganizations(db);
    slug = organizations.find((o) => o.organizationId === organizationId)?.slug ?? null;
  } catch (error) {
    return fail(error, { requestId, action: 'onboarding.createOrganization' });
  }
  // redirect() throws, so it must sit outside the try/catch that maps errors.
  redirect(slug ? `/app/${slug}/departments` : '/select-organization');
}
