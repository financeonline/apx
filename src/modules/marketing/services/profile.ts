import 'server-only';
import { callApi } from '@/core/db/api-rpc';
import { NotFound, ValidationError } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import { parseCompanyProfile, type CompanyProfileForm } from '../domain/profile';
import type { CompanyProfile } from '../domain/types';

/**
 * Saving the company profile (ADR-170). `customers.edit` — the permission that records the company's
 * commercial facts, held by the owner, an admin and the assigned APX adviser, never a client — checked
 * here and again inside `api.set_company_profile`, which validates every field once more and audits
 * the change. The whole profile is replaced: the form always sends every field.
 *
 * The profile's industry is the organisation's own (`organizations.industry`); saving it here changes
 * it there.
 */
export async function setCompanyProfile(ctx: AccessContext, input: CompanyProfileForm): Promise<CompanyProfile> {
  assertCan(ctx, 'customers.edit');
  if (!ctx.orgId) throw new NotFound();
  const parsed = parseCompanyProfile(input);
  if (!parsed.ok) throw new ValidationError('Some details need fixing.', [...parsed.issues]);
  const p = parsed.profile;
  await callApi<string>(ctx.db, 'set_company_profile', {
    p_org: ctx.orgId,
    p_website: p.website,
    p_social_links: p.socialLinks.map((l) => ({ label: l.label, url: l.url })),
    p_products_services: p.productsServices,
    p_industry: p.industry,
    p_description: p.description,
  }, ctx.requestId);
  return p;
}
