'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { createOrganization, landingPathForRole, listMyOrganizations } from '@/modules/tenancy';
import { newRequestId } from '@/core/logging';
import { fail, text, integer } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

export async function createOrganizationAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const requestId = newRequestId();
  let landing: string | null = null;
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
    const created = organizations.find((o) => o.organizationId === organizationId);
    // The creator is its owner, so this is Departments; asked through the one landing rule (ADR-172)
    // rather than spelled here, so the four ways into a company cannot disagree.
    landing = created ? landingPathForRole(created.slug, created.role) : null;
  } catch (error) {
    return fail(error, { requestId, action: 'onboarding.createOrganization' });
  }
  // redirect() throws, so it must sit outside the try/catch that maps errors.
  redirect(landing ?? '/select-organization');
}
