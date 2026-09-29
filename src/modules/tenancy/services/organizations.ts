import 'server-only';
import { z } from 'zod';
import { assertCan } from '@/core/permissions';
import { ValidationError, toMotionError } from '@/core/errors';
import { callApi } from '../data/rpc';
import type { AccessContext } from '../context';
import type { SupabaseClient } from '@supabase/supabase-js';

export const CreateOrganizationInput = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(200),
  countryCode: z.string().length(2).default('GB'),
  baseCurrency: z.string().length(3).default('GBP'),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
  timezone: z.string().min(1).default('Europe/London'),
});
export type CreateOrganizationInput = z.infer<typeof CreateOrganizationInput>;

export interface OrganizationSummary {
  organizationId: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended' | 'pending_deletion' | 'deleted';
  role: string;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      'Some details need fixing.',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/** Self-serve organization creation. The caller becomes its owner (DATABASE_ARCHITECTURE.md §14.1). */
export async function createOrganization(
  db: SupabaseClient,
  input: unknown,
  requestId?: string,
): Promise<string> {
  const parsed = parse(CreateOrganizationInput, input);
  return callApi<string>(
    db,
    'create_organization',
    {
      p_name: parsed.name,
      p_country_code: parsed.countryCode,
      p_base_currency: parsed.baseCurrency,
      p_fiscal_year_start_month: parsed.fiscalYearStartMonth,
      p_timezone: parsed.timezone,
    },
    requestId,
  );
}

export const UpdateOrganizationPatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    legal_name: z.string().trim().max(200).optional(),
    fiscal_year_start_month: z.number().int().min(1).max(12).optional(),
    timezone: z.string().min(1).optional(),
    industry: z.string().max(120).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export async function updateOrganization(
  ctx: AccessContext,
  patch: unknown,
): Promise<string> {
  assertCan(ctx, 'settings.manage');
  const parsed = parse(UpdateOrganizationPatch, patch);
  return callApi<string>(ctx.db, 'update_organization', { p_org: ctx.orgId, p_patch: parsed }, ctx.requestId);
}

export async function requestDeletion(ctx: AccessContext): Promise<string> {
  assertCan(ctx, 'org.delete');
  return callApi<string>(ctx.db, 'request_deletion', { p_org: ctx.orgId }, ctx.requestId);
}

export async function cancelDeletion(ctx: AccessContext): Promise<string> {
  assertCan(ctx, 'org.delete');
  return callApi<string>(ctx.db, 'cancel_deletion', { p_org: ctx.orgId }, ctx.requestId);
}

/** Rows per page when reading the accessible set: PostgREST's `max_rows`. */
const ORGANIZATION_PAGE = 1_000;

/**
 * One statement regardless of organization count (ADR-038.13), read in pages of `max_rows` so an
 * accessible set larger than one page — a super admin's, past 1,000 organisations — is read whole
 * rather than silently cut (ADR-117). Name order, with the id as the tiebreaker that makes pages stable.
 */
export async function listMyOrganizations(db: SupabaseClient): Promise<OrganizationSummary[]> {
  const rows: Array<Record<string, string>> = [];
  for (let from = 0; ; from += ORGANIZATION_PAGE) {
    const { data, error } = await db.schema('api').rpc('my_organizations', {})
      .order('name').order('organization_id').range(from, from + ORGANIZATION_PAGE - 1);
    if (error) throw toMotionError(error);
    const page = (data ?? []) as Array<Record<string, string>>;
    rows.push(...page);
    if (page.length < ORGANIZATION_PAGE) break;
  }
  return rows.map((r) => ({
    organizationId: r.organization_id!,
    slug: r.slug!,
    name: r.name!,
    status: r.status as OrganizationSummary['status'],
    role: r.role!,
  }));
}

export async function setLastActiveOrg(db: SupabaseClient, organizationId: string): Promise<void> {
  await callApi(db, 'set_last_active_org', { p_org: organizationId });
}
