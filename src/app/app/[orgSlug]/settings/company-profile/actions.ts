'use server';

import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { setCompanyProfile } from '@/modules/marketing';
import { fail, done, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * Saves the company profile (ADR-170). The context comes from the slug, never the form; the service
 * asserts `customers.edit`, checks every field and calls `api.set_company_profile`, which checks them
 * again and audits the change. The social links arrive as rows of two parallel fields.
 */
export async function saveCompanyProfileAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    const labels = form.getAll('social_label').map((v) => (typeof v === 'string' ? v : ''));
    const urls = form.getAll('social_url').map((v) => (typeof v === 'string' ? v : ''));
    const rows = Math.max(labels.length, urls.length);
    await setCompanyProfile(ctx, {
      website: text(form, 'website'),
      socialLinks: Array.from({ length: rows }, (_, i) => ({ label: labels[i] ?? '', url: urls[i] ?? '' })),
      productsServices: text(form, 'products_services'),
      industry: text(form, 'industry'),
      description: text(form, 'description'),
    });
    revalidatePath(`/app/${orgSlug}/settings/company-profile`);
    revalidatePath(`/app/${orgSlug}/marketing`);
    return done('Saved. Refresh the marketing report to use these details.');
  } catch (error) {
    return fail(error, { requestId, action: 'settings.saveCompanyProfile' });
  }
}
