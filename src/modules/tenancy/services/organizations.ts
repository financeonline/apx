import 'server-only';
import { z } from 'zod';
import { assertCan } from '@/core/permissions';
import { ValidationError } from '@/core/errors';
import { callApi } from '../data/rpc';
import type { AccessContext } from '../context';
import type { Db } from '@/db/types';
import { globalRow } from '@/db/schema';
import { orgRoleOf } from '@/db/app/access';
import { NotFound } from '@/core/errors';

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
  db: Db,
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

/** ADR-133: the three VAT states. "unknown" is a state, never stored as false. */
export const VatStatus = z.enum(['registered', 'not_registered', 'unknown']);
export type VatStatus = z.infer<typeof VatStatus>;

/**
 * Sets the organisation's VAT status through its own audited path (`api.set_vat_registration`): it
 * merges its key only, and a change queues a full recalculation, because it decides which days
 * figures can be stated at all (ADR-129, ADR-133).
 */
export async function setVatRegistration(ctx: AccessContext, status: unknown): Promise<VatStatus> {
  assertCan(ctx, 'settings.manage');
  const parsed = parse(VatStatus, status);
  return callApi<VatStatus>(ctx.db, 'set_vat_registration', { p_org: ctx.orgId, p_status: parsed }, ctx.requestId);
}

/** The stored setting read back as one of the three states. */
export function vatStatusOf(settings: unknown): VatStatus {
  const value = (settings as Record<string, unknown> | null)?.vat_registered;
  return value === true ? 'registered' : value === false ? 'not_registered' : 'unknown';
}

/**
 * ADR-156: the tax settings the indicative VAT return and Corporation Tax estimate read — which month
 * the first VAT quarter ends in (the three UK stagger groups), the VAT scheme, and the number of
 * associated companies (they share the Corporation Tax limits). Read when a report is drawn; no
 * stored figure depends on them, so a change queues no recalculation.
 */
export const VatScheme = z.enum(['standard', 'cash_accounting', 'flat_rate']);
export type VatScheme = z.infer<typeof VatScheme>;

export const TaxSettingsInput = z.object({
  vatQuarterEndMonth: z.union([z.literal(1), z.literal(2), z.literal(3)], {
    error: 'Choose when your VAT quarters end',
  }),
  vatScheme: VatScheme,
  ctAssociatedCompanies: z.number().int().min(0, 'Enter a number from 0 to 50').max(50, 'Enter a number from 0 to 50'),
});
export type TaxSettingsInput = z.infer<typeof TaxSettingsInput>;

export interface TaxSettings {
  /** 1, 2 or 3; null when it has never been set. */
  readonly vatQuarterEndMonth: 1 | 2 | 3 | null;
  readonly vatScheme: VatScheme;
  readonly ctAssociatedCompanies: number;
}

export async function setTaxSettings(ctx: AccessContext, input: unknown): Promise<TaxSettings> {
  assertCan(ctx, 'settings.manage');
  const parsed = parse(TaxSettingsInput, input);
  await callApi<unknown>(ctx.db, 'set_tax_settings', {
    p_org: ctx.orgId,
    p_vat_quarter_end_month: parsed.vatQuarterEndMonth,
    p_vat_scheme: parsed.vatScheme,
    p_ct_associated_companies: parsed.ctAssociatedCompanies,
  }, ctx.requestId);
  return parsed;
}

/** The stored tax settings read back, null-safe: an unset quarter is null, never guessed. */
export function taxSettingsOf(settings: unknown): TaxSettings {
  const s = (settings as Record<string, unknown> | null) ?? {};
  const month = s.vat_quarter_end_month;
  const scheme = VatScheme.safeParse(s.vat_scheme);
  const associated = s.ct_associated_companies;
  return {
    vatQuarterEndMonth: month === 1 || month === 2 || month === 3 ? month : null,
    vatScheme: scheme.success ? scheme.data : 'standard',
    ctAssociatedCompanies:
      typeof associated === 'number' && Number.isInteger(associated) && associated >= 0 && associated <= 50
        ? associated
        : 0,
  };
}

/**
 * ADR-156: currency and country after creation. Country can always change; the currency only while
 * the organisation holds no financial records — amounts are never converted, so `api.set_currency_and_country`
 * refuses a relabel of existing figures.
 */
export const OrgCurrency = z.enum(['GBP', 'AED', 'EUR', 'USD', 'INR']);
export type OrgCurrency = z.infer<typeof OrgCurrency>;
export const OrgCountry = z.enum(['GB', 'AE', 'IE', 'IN']);
export type OrgCountry = z.infer<typeof OrgCountry>;

export const CurrencyAndCountryInput = z.object({
  currency: OrgCurrency,
  country: OrgCountry,
});
export type CurrencyAndCountryInput = z.infer<typeof CurrencyAndCountryInput>;

export async function setCurrencyAndCountry(
  ctx: AccessContext,
  input: unknown,
): Promise<CurrencyAndCountryInput> {
  assertCan(ctx, 'settings.manage');
  const parsed = parse(CurrencyAndCountryInput, input);
  await callApi<unknown>(ctx.db, 'set_currency_and_country', {
    p_org: ctx.orgId,
    p_currency: parsed.currency,
    p_country: parsed.country,
  }, ctx.requestId);
  return parsed;
}

export async function requestDeletion(ctx: AccessContext): Promise<string> {
  assertCan(ctx, 'org.delete');
  return callApi<string>(ctx.db, 'request_deletion', { p_org: ctx.orgId }, ctx.requestId);
}

export async function cancelDeletion(ctx: AccessContext): Promise<string> {
  assertCan(ctx, 'org.delete');
  return callApi<string>(ctx.db, 'cancel_deletion', { p_org: ctx.orgId }, ctx.requestId);
}

/**
 * Every organisation the caller reaches, in name order with the id as the tiebreaker
 * (`api.my_organizations`). One call regardless of how many (ADR-038.13): the accessible set is read
 * whole, never cut at a page (ADR-117).
 */
export async function listMyOrganizations(db: Db): Promise<OrganizationSummary[]> {
  const rows = (await callApi<Array<Record<string, string>> | null>(db, 'my_organizations', {})) ?? [];
  return rows.map((r) => ({
    organizationId: r.organization_id!,
    slug: r.slug!,
    name: r.name!,
    status: r.status as OrganizationSummary['status'],
    role: r.role!,
  }));
}

export async function setLastActiveOrg(db: Db, organizationId: string): Promise<void> {
  await callApi(db, 'set_last_active_org', { p_org: organizationId });
}

/** The organisation document's fields a settings page shows. */
export interface OrganizationRecord {
  readonly id: string;
  readonly name: string;
  readonly legal_name: string | null;
  readonly slug: string;
  readonly timezone: string;
  readonly fiscal_year_start_month: number;
  readonly base_currency: string;
  readonly country_code: string | null;
  readonly status: string;
  readonly plan: string;
  readonly features: Record<string, unknown>;
  readonly settings: Record<string, unknown>;
}

/**
 * The caller's organisation, read as the server: `organizations_select` admitted an organisation in
 * the caller's accessible set, and `orgRoleOf` is that set's test for one organisation.
 */
export async function organizationOf(ctx: AccessContext): Promise<OrganizationRecord> {
  const o = ctx.orgId ? await organizationDoc(ctx.db, ctx.orgId) : null;
  if (!o) throw new NotFound();
  return {
    id: String(o.id), name: String(o.name ?? ''), legal_name: (o.legal_name as string | null) ?? null, slug: String(o.slug ?? ''),
    timezone: String(o.timezone ?? 'Europe/London'), fiscal_year_start_month: Number(o.fiscal_year_start_month ?? 1),
    base_currency: String(o.base_currency ?? 'GBP'), country_code: (o.country_code as string | null) ?? null,
    status: String(o.status ?? 'active'), plan: String(o.plan ?? 'trial'),
    features: (o.features as Record<string, unknown> | undefined) ?? {},
    settings: (o.settings as Record<string, unknown> | undefined) ?? {},
  };
}

/**
 * One organisation's document as the caller may read it (`organizations_select`: an organisation in
 * the caller's accessible set), or null — the replacement for `db.from('organizations')…`.
 */
export async function organizationDoc(db: Db, orgId: string): Promise<Record<string, unknown> | null> {
  const uid = db.actor.kind === 'user' ? db.actor.userId : null;
  if (!uid || !orgId || !(await orgRoleOf(db.fs, uid, orgId))) return null;
  const snap = await globalRow(db.fs, 'organizations', orgId).get();
  return snap.exists ? { ...snap.data()!, id: snap.id } : null;
}
