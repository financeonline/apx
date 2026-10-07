import 'server-only';
import { createServiceClient } from '@/core/db';
import { callApi } from '@/core/db/api-rpc';
import { ConflictError, NotFound, ValidationError, isMotionError, toMotionError } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import { MODULES, type AccessContext } from '@/modules/tenancy';
import {
  AddPlatformUserInput, CreateCompanyInput, parseInput,
} from '../domain/inputs';

/**
 * The platform's own reads and writes (ROUTE_ARCHITECTURE.md §150, §155, §156; ADR-088).
 *
 * Every read runs under the platform user's own client: `organizations`, `jobs`, `platform_*` and
 * the audit trail are all gated on `app.is_super_admin()` or an accessible-org role, so these pages
 * hold no service role and cannot show what RLS would hide. The two name-resolving reads go through
 * definer functions because `profiles` is own-row-only.
 */

export interface PlatformOrganization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly status: string;
  readonly plan: string;
  readonly kind: string | null;
  readonly countryCode: string | null;
  readonly industry: string | null;
  readonly baseCurrency: string;
  readonly fiscalYearStartMonth: number;
  readonly timezone: string | null;
  readonly features: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly deletionRequestedAt: string | null;
}

export interface OrgQuotas {
  readonly aiQuotaDaily: number | null;
  readonly aiTokenCeilingMonthly: number | null;
  readonly aiExtractionPagesPerDay: number | null;
  readonly notes: string | null;
}

export interface PlatformMember {
  readonly userId: string;
  readonly fullName: string | null;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly joinedAt: string;
}

export interface PlatformAssignment {
  readonly id: string;
  readonly employeeUserId: string;
  readonly status: string;
  readonly endsAt: string | null;
}

export interface OrganizationDetail {
  readonly organization: PlatformOrganization;
  readonly quotas: OrgQuotas;
  readonly members: readonly PlatformMember[];
  readonly assignments: readonly PlatformAssignment[];
  readonly counts: { readonly documents: number; readonly batches: number; readonly conversations: number };
}

export async function loadOrganizationDetail(ctx: AccessContext, orgId: string): Promise<OrganizationDetail> {
  assertCan(ctx, 'platform.orgs.manage');
  const { data, error } = await ctx.db
    .from('organizations')
    .select('id, slug, name, legal_name, status, plan, kind, country_code, industry, base_currency, fiscal_year_start_month, timezone, features, created_at, deletion_requested_at')
    .eq('id', orgId)
    .maybeSingle();
  if (error) throw toMotionError(error, ctx.requestId);
  if (!data) throw new NotFound();
  const row = data as Record<string, unknown>;

  const [settings, members, assignments, documents, batches, conversations] = await Promise.all([
    ctx.db.from('platform_org_settings').select('ai_quota_daily, ai_token_ceiling_monthly, ai_extraction_pages_per_day, notes').eq('organization_id', orgId).maybeSingle(),
    callApi<Array<Record<string, string>>>(ctx.db, 'org_members', { p_org: orgId }, ctx.requestId),
    ctx.db.from('organization_assignments').select('id, employee_user_id, status, ends_at').eq('organization_id', orgId),
    ctx.db.from('source_documents').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).is('deleted_at', null),
    ctx.db.from('import_batches').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    ctx.db.from('ai_conversations').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
  ]);
  if (settings.error) throw toMotionError(settings.error, ctx.requestId);
  if (assignments.error) throw toMotionError(assignments.error, ctx.requestId);

  const s = settings.data as Record<string, unknown> | null;
  return {
    organization: {
      id: row.id as string, slug: row.slug as string, name: row.name as string,
      legalName: (row.legal_name as string | null) ?? null,
      status: row.status as string, plan: row.plan as string,
      kind: (row.kind as string | null) ?? null,
      countryCode: (row.country_code as string | null) ?? null,
      industry: (row.industry as string | null) ?? null,
      baseCurrency: row.base_currency as string,
      fiscalYearStartMonth: Number(row.fiscal_year_start_month ?? 1),
      timezone: (row.timezone as string | null) ?? null,
      features: (row.features as Record<string, unknown>) ?? {},
      createdAt: row.created_at as string,
      deletionRequestedAt: (row.deletion_requested_at as string | null) ?? null,
    },
    quotas: {
      aiQuotaDaily: (s?.ai_quota_daily as number | null) ?? null,
      aiTokenCeilingMonthly: (s?.ai_token_ceiling_monthly as number | null) ?? null,
      aiExtractionPagesPerDay: (s?.ai_extraction_pages_per_day as number | null) ?? null,
      notes: (s?.notes as string | null) ?? null,
    },
    members: (members ?? []).map((m) => ({
      userId: m.user_id!, fullName: m.full_name ?? null, email: m.email!,
      role: m.role!, status: m.status!, joinedAt: m.joined_at!,
    })),
    assignments: ((assignments.data ?? []) as Array<Record<string, unknown>>).map((a) => ({
      id: a.id as string, employeeUserId: a.employee_user_id as string,
      status: a.status as string, endsAt: (a.ends_at as string | null) ?? null,
    })),
    counts: { documents: documents.count ?? 0, batches: batches.count ?? 0, conversations: conversations.count ?? 0 },
  };
}

export interface AuditFilters {
  readonly organizationId?: string | null;
  readonly action?: string | null;
  readonly actorUserId?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly limit?: number;
  readonly offset?: number;
}

export interface PlatformAuditEvent {
  readonly id: number;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly action: string;
  readonly actorType: string;
  readonly actorName: string | null;
  readonly targetTable: string | null;
  readonly targetId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

/** The global trail (ADR-088). Super admin at aal2; the function refuses anyone else. */
export async function searchAudit(ctx: AccessContext, filters: AuditFilters = {}): Promise<PlatformAuditEvent[]> {
  assertCan(ctx, 'audit.view');
  const rows = await callApi<Array<Record<string, unknown>>>(ctx.db, 'platform_audit_events', {
    p_org: filters.organizationId ?? null,
    p_action: filters.action ?? null,
    p_actor: filters.actorUserId ?? null,
    p_from: filters.from ?? null,
    p_to: filters.to ?? null,
    p_limit: filters.limit ?? 100,
    p_offset: filters.offset ?? 0,
  }, ctx.requestId);
  return (rows ?? []).map((r) => ({
    id: Number(r.id),
    organizationId: (r.organization_id as string | null) ?? null,
    organizationName: (r.organization_name as string | null) ?? null,
    action: r.action as string,
    actorType: r.actor_type as string,
    actorName: (r.actor_name as string | null) ?? null,
    targetTable: (r.target_table as string | null) ?? null,
    targetId: (r.target_id as string | null) ?? null,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: r.created_at as string,
  }));
}

export interface PlatformSetting {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: string;
}

export async function loadPlatformSettings(ctx: AccessContext): Promise<PlatformSetting[]> {
  assertCan(ctx, 'system.manage');
  const { data, error } = await ctx.db.from('platform_settings').select('key, value, updated_at').order('key');
  if (error) throw toMotionError(error, ctx.requestId);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    key: r.key as string, value: r.value, updatedAt: r.updated_at as string,
  }));
}

export async function updatePlatformSetting(ctx: AccessContext, key: string, value: unknown): Promise<void> {
  assertCan(ctx, 'system.manage');
  await callApi(ctx.db, 'update_platform_settings', { p_key: key, p_value: value }, ctx.requestId);
}

/**
 * The AI provider key (ADR-157): set by the app's owner, stored encrypted in Vault, shown only as
 * its last four characters. A new key is tried against the provider before it is stored, so a
 * mistyped key is refused here rather than discovered when every analyst question fails.
 */
export interface AiKeyStatus {
  readonly configured: boolean;
  readonly ending: string | null;
  readonly updatedAt: string | null;
  /** True when no key is stored but the server has its own ANTHROPIC_API_KEY. */
  readonly serverFallback: boolean;
}

export async function loadAiKeyStatus(ctx: AccessContext): Promise<AiKeyStatus> {
  assertCan(ctx, 'system.manage');
  const rows = await callApi<Array<{ configured: boolean; ending: string | null; updated_at: string | null }>>(
    ctx.db, 'ai_api_key_status', {}, ctx.requestId,
  );
  const row = (rows ?? [])[0];
  return {
    configured: row?.configured === true,
    ending: row?.ending ?? null,
    updatedAt: row?.updated_at ?? null,
    serverFallback: !row?.configured && Boolean(process.env.ANTHROPIC_API_KEY),
  };
}

/** Does the provider accept this key? A read-only call (the model list); nothing is generated. */
async function providerAccepts(key: string): Promise<boolean> {
  const response = await fetch('https://api.anthropic.com/v1/models?limit=1', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(10_000),
  });
  return response.ok;
}

export async function setAiKey(ctx: AccessContext, key: string): Promise<string> {
  assertCan(ctx, 'system.manage');
  const trimmed = key.trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
    throw new ValidationError('That does not look like an Anthropic API key (it starts sk-ant-).');
  }
  let accepted: boolean;
  try {
    accepted = await providerAccepts(trimmed);
  } catch {
    throw new ValidationError('Anthropic could not be reached to check the key. Try again in a moment.');
  }
  if (!accepted) throw new ValidationError('Anthropic did not accept that key. Check it and try again.');
  return await callApi<string>(ctx.db, 'set_ai_api_key', { p_key: trimmed }, ctx.requestId);
}

export async function clearAiKey(ctx: AccessContext): Promise<boolean> {
  assertCan(ctx, 'system.manage');
  return await callApi<boolean>(ctx.db, 'clear_ai_api_key', {}, ctx.requestId);
}

export async function updateOrgQuotas(ctx: AccessContext, orgId: string, patch: Record<string, unknown>): Promise<void> {
  assertCan(ctx, 'platform.orgs.manage');
  await callApi(ctx.db, 'update_platform_org_settings', { p_org: orgId, p_patch: patch }, ctx.requestId);
}

export async function updateOrganizationAsPlatform(ctx: AccessContext, orgId: string, patch: Record<string, unknown>): Promise<void> {
  assertCan(ctx, 'platform.orgs.manage');
  await callApi(ctx.db, 'update_organization', { p_org: orgId, p_patch: patch }, ctx.requestId);
}

/**
 * Switch one system on or off for a company (ADR-158). `api.set_org_module` merges this one key
 * into `organizations.features`, so a concurrent change to another switch is never overwritten.
 */
export async function setOrgModule(ctx: AccessContext, orgId: string, featureKey: string, on: boolean): Promise<void> {
  assertCan(ctx, 'platform.orgs.manage');
  if (!MODULES.some((m) => m.featureKey === featureKey)) throw new ValidationError('That is not a system a company can switch.');
  await callApi(ctx.db, 'set_org_module', { p_org: orgId, p_feature_key: featureKey, p_on: on }, ctx.requestId);
}

export interface CreatedCompany {
  readonly organizationId: string;
  readonly slug: string;
  readonly invitationToken: string;
}

/**
 * A super admin creates a company and invites its owner (ADR-158). The owner joins through
 * `/invite/{token}`; the raw token is returned once and only its hash is stored.
 */
export async function createCompanyAsPlatform(ctx: AccessContext, input: unknown): Promise<CreatedCompany> {
  assertCan(ctx, 'platform.orgs.manage');
  const value = parseInput(CreateCompanyInput, input);
  const rows = await callApi<Array<{ organization_id: string; slug: string; invitation_token: string }>>(
    ctx.db, 'platform_create_organization', {
      p_name: value.name,
      p_country_code: value.countryCode,
      p_base_currency: value.baseCurrency,
      p_fiscal_year_start_month: value.fiscalYearStartMonth,
      p_timezone: '',
      p_owner_email: value.ownerEmail,
    }, ctx.requestId,
  );
  const row = (rows ?? [])[0];
  if (!row) throw new Error('The company was not created.');
  return { organizationId: row.organization_id, slug: row.slug, invitationToken: row.invitation_token };
}

export interface PlatformUser {
  readonly userId: string;
  readonly email: string | null;
  readonly fullName: string | null;
  readonly platformRole: string;
  readonly status: string;
  readonly twoStep: boolean;
  readonly createdAt: string;
}

export async function listPlatformUsers(ctx: AccessContext): Promise<PlatformUser[]> {
  assertCan(ctx, 'platform.users.manage');
  const rows = await callApi<Array<Record<string, unknown>>>(ctx.db, 'platform_users_list', {}, ctx.requestId);
  return (rows ?? []).map((r) => ({
    userId: r.user_id as string,
    email: (r.email as string | null) ?? null,
    fullName: (r.full_name as string | null) ?? null,
    platformRole: r.platform_role as string,
    status: r.status as string,
    twoStep: r.two_step === true,
    createdAt: r.created_at as string,
  }));
}

/** An existing account's id, or null. GoTrue's admin API has no lookup by email, so it is paged. */
async function findAuthUserIdByEmail(email: string): Promise<string | null> {
  const admin = createServiceClient().auth.admin;
  const perPage = 1000;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.listUsers({ page, perPage });
    if (error) throw toMotionError(error);
    const found = data.users.find((u) => (u.email ?? '').toLowerCase() === email);
    if (found) return found.id;
    if (data.users.length < perPage) return null;
  }
  return null;
}

export interface AddedPlatformUser {
  readonly userId: string;
  readonly invited: boolean;
}

/**
 * Give someone a platform role by email (ADR-158). The service role only finds or invites the
 * account; the grant itself runs as the acting super admin (`api.grant_platform_role`), which is
 * where the authority is checked and the grant is audited. An account that belongs to a company is
 * refused by the database: platform admins need their own login.
 */
export async function addPlatformUser(
  ctx: AccessContext,
  input: unknown,
  options: { readonly redirectTo: string },
): Promise<AddedPlatformUser> {
  assertCan(ctx, 'platform.users.manage');
  const { email, role } = parseInput(AddPlatformUserInput, input);

  let userId = await findAuthUserIdByEmail(email);
  let invited = false;
  if (!userId) {
    const { data, error } = await createServiceClient().auth.admin.inviteUserByEmail(email, { redirectTo: options.redirectTo });
    if (error || !data.user) throw toMotionError(error ?? new Error('The invitation was not sent.'), ctx.requestId);
    userId = data.user.id;
    invited = true;
  }

  try {
    await callApi(ctx.db, 'grant_platform_role', { p_user: userId, p_role: role }, ctx.requestId);
  } catch (error) {
    if (isMotionError(error) && /member of an organi[sz]ation/i.test(error.message)) {
      throw new ConflictError('That email belongs to a company account. Platform admins need their own login.');
    }
    throw error;
  }
  return { userId, invited };
}
