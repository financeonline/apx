import 'server-only';
import { anthropicApiKeyFromVault, openAiApiKeyFromVault, revokeUserSessions } from '@/core/db';
import {
  createConfirmedLogin, inviteLogin, isEmailTaken, loginIdByEmail, removeLogin, updateLogin,
} from '@/db/app/platform-auth';
import { countOrgRows, readActiveAssignments, readableOrganization, readGlobal } from '@/db/app/platform-reads';
import { orgRowById, orgRows } from '@/db/rls';
import { ORG_SINGLETON_ID } from '@/db/schema';
import { DEFAULT_ANALYST_MODEL, OPENAI_EFFORTS, isOpenAiChatModel, isOpenAiReasoningModel } from '@/modules/ai';
import { callApi } from '@/core/db/api-rpc';
import { ConflictError, NotFound, ValidationError, isMotionError } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import { MODULES, type AccessContext } from '@/modules/tenancy';
import {
  AddPlatformUserInput, CreateCompanyInput, EditCompanyInput, parseInput,
} from '../domain/inputs';

/**
 * The platform's own reads and writes (ROUTE_ARCHITECTURE.md §150, §155, §156; ADR-088).
 *
 * Every read is made for the platform user and filtered by the policy the table had: tenant tables
 * through `src/db/rls.ts`, the top-level `organizations`, `jobs` and `platform_*` collections through
 * `src/db/app/platform-reads.ts` — gated on the super admin or an accessible-org role — so these pages cannot show what
 * RLS would have hidden. The two name-resolving reads go through `api.*` functions because
 * `profiles` is own-row-only.
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
  const row = await readableOrganization(ctx.db, orgId);
  if (!row) throw new NotFound();

  const [settings, members, assignments, documents, batches, conversations] = await Promise.all([
    orgRowById<Record<string, unknown>>(ctx.db, orgId, 'platform_org_settings', ORG_SINGLETON_ID),
    callApi<Array<Record<string, string>>>(ctx.db, 'org_members', { p_org: orgId }, ctx.requestId),
    orgRows<Record<string, unknown>>(ctx.db, orgId, 'organization_assignments'),
    countOrgRows(ctx.db, orgId, 'source_documents', (q) => q.where('deleted_at', '==', null)),
    countOrgRows(ctx.db, orgId, 'import_batches'),
    countOrgRows(ctx.db, orgId, 'ai_conversations'),
  ]);

  const s = settings;
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
    assignments: assignments.map((a) => ({
      id: a.id as string, employeeUserId: a.employee_user_id as string,
      status: a.status as string, endsAt: (a.ends_at as string | null) ?? null,
    })),
    counts: { documents, batches, conversations },
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
  readonly id: string;
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

/** The global trail (ADR-088). The super admin only; the function refuses anyone else. */
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
    id: String(r.id),
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
  const rows = await readGlobal(ctx.db, 'platform_settings', (q) => q.orderBy('key'));
  return rows.map((r) => ({
    key: r.key as string, value: r.value, updatedAt: r.updated_at as string,
  }));
}

export async function updatePlatformSetting(ctx: AccessContext, key: string, value: unknown): Promise<void> {
  assertCan(ctx, 'system.manage');
  await callApi(ctx.db, 'update_platform_settings', { p_key: key, p_value: value }, ctx.requestId);
}

/**
 * The AI provider key (ADR-157): set by the app's owner, stored encrypted (`platform_secrets`, once Vault), shown only as
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
  /** The invitation link's token, or null when the owner's login was created with a password. */
  readonly invitationToken: string | null;
}

/**
 * A super admin creates a company and its owner (ADR-158, ADR-160).
 *
 * Without a password the owner joins through `/invite/{token}`; the raw token is returned once and
 * only its hash is stored. With a password the owner's login is created first (email confirmed, as
 * the super admin vouches for it) and made the owner as soon as the company exists, so they can sign
 * in straight away. An email that already has a login is refused for the password route: the super
 * admin never sets the password of an existing account — that person is invited instead. If the
 * company cannot be created, the login just made is removed again.
 */
export async function createCompanyAsPlatform(ctx: AccessContext, input: unknown): Promise<CreatedCompany> {
  assertCan(ctx, 'platform.orgs.manage');
  return createCompany(ctx, input);
}

/**
 * The creation itself, shared by the super admin and a Financial Analyst (ADR-187).
 * `api.platform_create_organization` decides who may create, and links an analyst to what they create.
 */
export async function createCompany(ctx: { readonly db: AccessContext['db']; readonly requestId: string }, input: unknown): Promise<CreatedCompany> {
  const value = parseInput(CreateCompanyInput, input);

  let ownerId: string | null = null;
  if (value.ownerPassword) {
    // Creating the login is also the check that the email is new: an existing account is refused by
    // Auth (`auth/email-already-exists`), so its password is never touched.
    try {
      // With its `profiles` document, as signing up makes one (TENANCY_MODEL.md §2).
      ownerId = await createConfirmedLogin(value.ownerEmail, value.ownerPassword);
    } catch (error) {
      if (isEmailTaken(error)) {
        throw new ConflictError('That email already has an APX login. Leave the password empty and send them the invitation link instead.');
      }
      const message = (error as { message?: string } | null)?.message;
      throw new ValidationError(message ? `The login was not created: ${message}` : 'The login was not created.');
    }
  }

  let row: { organization_id: string; slug: string; invitation_token: string } | undefined;
  try {
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
    row = (rows ?? [])[0];
    if (!row) throw new Error('The company was not created.');
  } catch (error) {
    if (ownerId) await removeLogin(ownerId);
    throw error;
  }

  if (ownerId) {
    await callApi(ctx.db, 'platform_set_company_owner', { p_org: row.organization_id, p_user: ownerId }, ctx.requestId);
    return { organizationId: row.organization_id, slug: row.slug, invitationToken: null };
  }
  return { organizationId: row.organization_id, slug: row.slug, invitationToken: row.invitation_token };
}

export interface PlatformUser {
  readonly userId: string;
  readonly email: string | null;
  readonly fullName: string | null;
  readonly platformRole: string;
  readonly status: string;
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
    createdAt: r.created_at as string,
  }));
}

export interface AddedPlatformUser {
  readonly userId: string;
  /** An invitation email was sent (no password was given and the address had no login). */
  readonly invited: boolean;
  /** The login was created here with the password given (ADR-184): they can sign in at once. */
  readonly created: boolean;
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
  const { email, role, fullName, password } = parseInput(AddPlatformUserInput, input);

  let userId = await loginIdByEmail(email);
  let invited = false;
  let created = false;
  if (userId && password) {
    throw new ValidationError('Some details need fixing.', [
      { path: 'password', message: 'That email already has a login. Leave the password blank to add that account to your team, or use a new email.' },
    ]);
  }
  if (!userId && password) {
    // ADR-184: the super admin sets the username and password; the account can sign in at once.
    try {
      userId = await createConfirmedLogin(email, password, fullName || null);
    } catch (error) {
      if (isEmailTaken(error)) throw new ConflictError('That email already has a login.');
      throw new ValidationError('Some details need fixing.', [{ path: 'password', message: 'Choose a stronger password.' }]);
    }
    created = true;
  }
  if (!userId) {
    try {
      userId = await inviteLogin(email, options.redirectTo);
    } catch {
      throw new ValidationError('The invitation email was not sent. Try again.');
    }
    invited = true;
  }

  try {
    await callApi(ctx.db, 'grant_platform_role', { p_user: userId, p_role: role }, ctx.requestId);
  } catch (error) {
    // A login made just now for a grant that failed is removed again: nothing half-made is left.
    if (created) await removeLogin(userId).catch(() => undefined);
    if (isMotionError(error) && /member of an organi[sz]ation/i.test(error.message)) {
      throw new ConflictError('That email belongs to a company account. Platform admins need their own login.');
    }
    throw error;
  }
  // (An invited person types their own name when they first sign in; an existing account keeps its.)
  return { userId, invited, created };
}

/** Each Financial Analyst's companies (organisation ids) that they can open now (ADR-182). */
export async function analystCompanies(ctx: AccessContext): Promise<ReadonlyMap<string, readonly string[]>> {
  assertCan(ctx, 'assignments.manage');
  const now = Date.now();
  const byAnalyst = new Map<string, string[]>();
  for (const a of await readActiveAssignments(ctx.db, 1000)) {
    if (typeof a.ends_at === 'string' && new Date(a.ends_at).getTime() <= now) continue;
    const list = byAnalyst.get(String(a.employee_user_id)) ?? [];
    list.push(String(a.organization_id));
    byAnalyst.set(String(a.employee_user_id), list);
  }
  return byAnalyst;
}

/**
 * Change a Financial Analyst's name, sign-in email and/or password (ADR-186). The decision and the
 * profile go through `api.platform_staff_login_change`; the login itself changes in Firebase Auth
 * (`updateLogin`). A changed email or password ends the person's other sessions.
 */
export async function changeStaffLoginAsPlatform(
  ctx: AccessContext, userId: string,
  change: { readonly fullName: string; readonly email: string; readonly password: string },
): Promise<void> {
  assertCan(ctx, 'platform.users.manage');
  const password = change.password;
  if (password && password.length < 12) throw new ValidationError('Use at least 12 characters for the password.');
  if (password.length > 72) throw new ValidationError('Keep the password under 72 characters.');
  const rows = await callApi<Array<{ user_id: string; email: string; email_changed: boolean }>>(
    ctx.db, 'platform_staff_login_change',
    { p_user: userId, p_new_email: change.email.trim(), p_full_name: change.fullName.trim(), p_password: Boolean(password) },
    ctx.requestId,
  );
  const result = (rows ?? [])[0];
  if (!result) throw new NotFound();
  if (result.email_changed || password) {
    try {
      await updateLogin(result.user_id, { email: result.email, password: password || null });
    } catch (error) {
      throw new ValidationError(`The login was not changed: ${(error as { message?: string } | null)?.message ?? 'unknown error'}`);
    }
    await revokeUserSessions(result.user_id);
  }
}

export interface AnalystCompaniesChange {
  readonly added: number;
  readonly removed: number;
  /** The companies the analyst can open after the change. */
  readonly total: number;
}

/**
 * Set exactly which companies one Financial Analyst can open (ADR-182): every ticked company gets
 * an assignment, every unticked one that had an active assignment is revoked. Each step is the
 * existing audited `api.create_assignment` / `api.revoke_assignment`, so the super admin's recent
 * sign-in and the per-company audit trail are unchanged; a company already in place is left alone,
 * keeping its end date.
 */
export async function setAnalystCompanies(
  ctx: AccessContext,
  employeeUserId: string,
  organizationIds: readonly string[],
): Promise<AnalystCompaniesChange> {
  assertCan(ctx, 'assignments.manage');
  if (!employeeUserId) throw new ValidationError('Choose a Financial Analyst.');
  const wanted = new Set(organizationIds.filter((id) => id.length > 0));
  const current = (await readActiveAssignments(ctx.db, 1000))
    .filter((a) => a.employee_user_id === employeeUserId);
  // A lapsed assignment (past its end date) no longer gives access, so ticking it renews it.
  const live = (a: Record<string, unknown>) => typeof a.ends_at !== 'string' || new Date(a.ends_at).getTime() > Date.now();
  const held = new Set(current.filter(live).map((a) => String(a.organization_id)));

  let added = 0, removed = 0;
  for (const org of wanted) {
    if (held.has(org)) continue;
    await callApi(ctx.db, 'create_assignment', { p_org: org, p_employee: employeeUserId, p_ends_at: null }, ctx.requestId);
    added += 1;
  }
  for (const a of current) {
    if (wanted.has(String(a.organization_id))) continue;
    await callApi(ctx.db, 'revoke_assignment', { p_assignment: String(a.id), p_reason: 'Companies changed by the super admin' }, ctx.requestId);
    removed += 1;
  }
  return { added, removed, total: wanted.size };
}

/**
 * The AI model and its effort (ADR-163), from Anthropic or OpenAI (ADR-164), chosen by the super
 * admin on Account. The models offered are the ones each provider lists for the key in use, with
 * the effort levels each one supports.
 */
export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiEffortLevel = (typeof AI_EFFORTS)[number];
export type AiProvider = 'anthropic' | 'openai';

export interface AiModelOption {
  readonly provider: AiProvider;
  readonly id: string;
  readonly name: string;
  /** The effort levels this model accepts; empty when it has no effort setting. */
  readonly efforts: readonly AiEffortLevel[];
}

export interface AiProviderChoice {
  readonly model: string;
  readonly effort: AiEffortLevel | null;
}

export interface AiModelSettings {
  /** The models the stored keys are offered; a provider that could not be reached lists none. */
  readonly options: readonly AiModelOption[];
  /** The provider the AI uses now (ADR-165); the other is inactive. */
  readonly active: AiProvider;
  /** Each provider's own model and effort; Anthropic's null means the default model. */
  readonly anthropic: AiProviderChoice | null;
  readonly openai: AiProviderChoice | null;
  /** The model used when Anthropic has no choice. */
  readonly defaultModel: string;
}

async function anthropicKeyInUse(): Promise<string | null> {
  return (await anthropicApiKeyFromVault().catch(() => null)) ?? process.env.ANTHROPIC_API_KEY ?? null;
}

async function openAiKeyInUse(): Promise<string | null> {
  return (await openAiApiKeyFromVault().catch(() => null)) ?? process.env.OPENAI_API_KEY ?? null;
}

async function anthropicModels(key: string): Promise<AiModelOption[]> {
  const response = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`model list ${response.status}`);
  const body = (await response.json()) as {
    data?: Array<{ id: string; display_name?: string; capabilities?: { effort?: Record<string, unknown> } | null }>;
  };
  return (body.data ?? []).map((m) => {
    const effort = m.capabilities?.effort as ({ supported?: boolean } & Record<string, { supported?: boolean } | boolean | undefined>) | undefined;
    const efforts = effort?.supported
      ? AI_EFFORTS.filter((level) => (effort[level] as { supported?: boolean } | undefined)?.supported === true)
      : [];
    return { provider: 'anthropic' as const, id: m.id, name: m.display_name ?? m.id, efforts };
  });
}

async function openAiModels(key: string): Promise<AiModelOption[]> {
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`model list ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id: string; created?: number }> };
  return (body.data ?? [])
    .filter((m) => isOpenAiChatModel(m.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((m) => ({
      provider: 'openai' as const, id: m.id, name: `OpenAI ${m.id}`,
      efforts: isOpenAiReasoningModel(m.id) ? [...OPENAI_EFFORTS] : [],
    }));
}

export async function loadAiModelSettings(ctx: AccessContext): Promise<AiModelSettings> {
  assertCan(ctx, 'system.manage');
  const [data] = await readGlobal(ctx.db, 'platform_settings', (q) => q.where('key', '==', 'ai_model'));
  const value = (data?.value ?? null) as { active?: unknown; anthropic?: unknown; openai?: unknown } | null;
  const slot = (raw: unknown): AiProviderChoice | null => {
    const v = raw as { model?: unknown; effort?: unknown } | null | undefined;
    if (!v || typeof v.model !== 'string') return null;
    return { model: v.model, effort: (AI_EFFORTS as readonly string[]).includes(String(v.effort)) ? v.effort as AiEffortLevel : null };
  };
  const [anthropicKey, openAiKey] = await Promise.all([anthropicKeyInUse(), openAiKeyInUse()]);
  const [fromAnthropic, fromOpenAi] = await Promise.all([
    anthropicKey ? anthropicModels(anthropicKey).catch(() => []) : Promise.resolve([]),
    openAiKey ? openAiModels(openAiKey).catch(() => []) : Promise.resolve([]),
  ]);
  return {
    options: [...fromAnthropic, ...fromOpenAi],
    active: value?.active === 'openai' ? 'openai' : 'anthropic',
    anthropic: slot(value?.anthropic),
    openai: slot(value?.openai),
    defaultModel: DEFAULT_ANALYST_MODEL,
  };
}

/** The tool MOTION requires a model to call — what the analyst's answer, document reading and the briefing depend on. */
const TRIAL_TOOL = { name: 'submit', description: 'Submit the word.', schema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } };

/** One small call with a REQUIRED tool call; returns the provider's refusal, or null when it worked. */
async function trialRefusal(provider: AiProvider, key: string, model: string, effort: string | null): Promise<string | null> {
  const request = provider === 'anthropic'
    ? fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 64, messages: [{ role: 'user', content: 'Submit the word OK.' }],
        tools: [{ name: TRIAL_TOOL.name, description: TRIAL_TOOL.description, input_schema: TRIAL_TOOL.schema }],
        tool_choice: { type: 'tool', name: TRIAL_TOOL.name },
        ...(effort ? { output_config: { effort } } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    : fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_completion_tokens: effort ? 2000 : 64, messages: [{ role: 'user', content: 'Submit the word OK.' }],
        tools: [{ type: 'function', function: { name: TRIAL_TOOL.name, description: TRIAL_TOOL.description, parameters: TRIAL_TOOL.schema } }],
        tool_choice: { type: 'function', function: { name: TRIAL_TOOL.name } },
        ...(effort ? { reasoning_effort: effort } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
  const trial = await request.catch(() => null);
  if (!trial) return 'could not be reached';
  if (trial.ok) return null;
  return ((await trial.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${trial.status}`;
}

/**
 * Choose one provider's model and effort (it does not change which provider is active, ADR-165). The
 * model must be one that provider offers the stored key and the effort one it supports; one tiny call
 * with a required tool proves the choice works before it is stored, so a choice can never leave every
 * analyst question failing. An empty Anthropic model goes back to the default.
 */
export async function setAiModel(
  ctx: AccessContext, choice: string, effort: string,
): Promise<{ provider: AiProvider; model: string | null; effort: string | null }> {
  assertCan(ctx, 'system.manage');
  const wantedEffort = effort.trim() || null;
  // The form sends "provider:model"; "Default" with an effort means the default model, named explicitly.
  const raw = choice.trim() || (wantedEffort ? `anthropic:${DEFAULT_ANALYST_MODEL}` : '');
  if (!raw) {
    await callApi(ctx.db, 'set_ai_model', { p_model: null, p_effort: null, p_provider: 'anthropic' }, ctx.requestId);
    return { provider: 'anthropic', model: null, effort: null };
  }
  const split = raw.indexOf(':');
  const provider: AiProvider = split > 0 && raw.slice(0, split) === 'openai' ? 'openai' : 'anthropic';
  const wantedModel = split > 0 && ['openai', 'anthropic'].includes(raw.slice(0, split)) ? raw.slice(split + 1) : raw;

  const key = provider === 'openai' ? await openAiKeyInUse() : await anthropicKeyInUse();
  if (!key) throw new ValidationError(provider === 'openai' ? 'Add an OpenAI key first.' : 'Add an Anthropic key first.');
  let options: AiModelOption[];
  try {
    options = provider === 'openai' ? await openAiModels(key) : await anthropicModels(key);
  } catch {
    throw new ValidationError(`${provider === 'openai' ? 'OpenAI' : 'Anthropic'} could not be reached to check the model. Try again in a moment.`);
  }
  const option = options.find((o) => o.id === wantedModel);
  if (!option) throw new ValidationError('Your key is not offered that model.');
  if (wantedEffort && !(option.efforts as readonly string[]).includes(wantedEffort)) {
    throw new ValidationError(option.efforts.length === 0
      ? `${option.name} has no effort setting. Choose "Model default".`
      : `${option.name} does not support ${wantedEffort} effort.`);
  }
  const refusal = await trialRefusal(provider, key, wantedModel, wantedEffort);
  if (refusal) {
    if (/tool_choice|tool choice|function/i.test(refusal)) {
      throw new ValidationError(`${option.name} cannot give APX the structured answers it needs yet, so it cannot be used. Choose another model.`);
    }
    throw new ValidationError(`${provider === 'openai' ? 'OpenAI' : 'Anthropic'} refused that choice: ${refusal}`);
  }
  await callApi(ctx.db, 'set_ai_model', { p_model: wantedModel, p_effort: wantedEffort, p_provider: provider }, ctx.requestId);
  return { provider, model: wantedModel, effort: wantedEffort };
}

/**
 * The OpenAI key (ADR-164): the Anthropic key's rules — checked with OpenAI before it is stored
 * encrypted, shown only as its last four characters.
 */
export async function loadOpenAiKeyStatus(ctx: AccessContext): Promise<{ configured: boolean; ending: string | null; updatedAt: string | null }> {
  assertCan(ctx, 'system.manage');
  const rows = await callApi<Array<{ configured: boolean; ending: string | null; updated_at: string | null }>>(
    ctx.db, 'openai_api_key_status', {}, ctx.requestId,
  );
  const row = (rows ?? [])[0];
  return { configured: row?.configured === true, ending: row?.ending ?? null, updatedAt: row?.updated_at ?? null };
}

export async function setOpenAiKey(ctx: AccessContext, key: string): Promise<string> {
  assertCan(ctx, 'system.manage');
  const trimmed = key.trim();
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(trimmed) || trimmed.startsWith('sk-ant-')) {
    throw new ValidationError('That does not look like an OpenAI API key (it starts sk-).');
  }
  let accepted: boolean;
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${trimmed}` }, signal: AbortSignal.timeout(10_000),
    });
    accepted = response.ok;
  } catch {
    throw new ValidationError('OpenAI could not be reached to check the key. Try again in a moment.');
  }
  if (!accepted) throw new ValidationError('OpenAI did not accept that key. Check it and try again.');
  return await callApi<string>(ctx.db, 'set_openai_api_key', { p_key: trimmed }, ctx.requestId);
}

export async function clearOpenAiKey(ctx: AccessContext): Promise<boolean> {
  assertCan(ctx, 'system.manage');
  return await callApi<boolean>(ctx.db, 'clear_openai_api_key', {}, ctx.requestId);
}

/** Make one provider active; the other becomes inactive (ADR-165). OpenAI needs its key and a model. */
export async function setActiveAiProvider(ctx: AccessContext, provider: string): Promise<AiProvider> {
  assertCan(ctx, 'system.manage');
  if (provider !== 'anthropic' && provider !== 'openai') throw new ValidationError('Choose Anthropic or OpenAI.');
  await callApi(ctx.db, 'set_ai_active_provider', { p_provider: provider }, ctx.requestId);
  return provider;
}

/**
 * Edit a company from the list (ADR-166): name, legal name, financial year start and plan through
 * `api.update_organization` (the super admin's patch); country and currency through
 * `api.set_currency_and_country`, which refuses a currency change once the company holds records
 * (amounts are never converted). Only what changed is sent.
 */
export async function editCompanyAsPlatform(ctx: AccessContext, orgId: string, input: unknown): Promise<void> {
  assertCan(ctx, 'platform.orgs.manage');
  const value = parseInput(EditCompanyInput, input);
  const data = await readableOrganization(ctx.db, orgId);
  if (!data) throw new NotFound();
  const before = data as { name: string; legal_name: string | null; country_code: string | null; base_currency: string; fiscal_year_start_month: number; plan: string };

  const patch: Record<string, unknown> = {};
  if (value.name !== before.name) patch.name = value.name;
  if (value.legalName !== (before.legal_name ?? '')) patch.legal_name = value.legalName;
  if (value.fiscalYearStartMonth !== Number(before.fiscal_year_start_month)) patch.fiscal_year_start_month = value.fiscalYearStartMonth;
  if (value.plan !== before.plan) patch.plan = value.plan;
  if (Object.keys(patch).length > 0) await callApi(ctx.db, 'update_organization', { p_org: orgId, p_patch: patch }, ctx.requestId);

  if (value.countryCode !== before.country_code || value.baseCurrency !== before.base_currency) {
    await callApi(ctx.db, 'set_currency_and_country', { p_org: orgId, p_currency: value.baseCurrency, p_country: value.countryCode }, ctx.requestId);
  }
}

/**
 * Delete a company (ADR-166): the existing deletion path, `api.request_deletion` — the company leaves
 * use at once and its data is erased for good thirty days later by `org.purge`; until then it can be
 * restored. Nothing is erased on the spot.
 */
export async function deleteCompanyAsPlatform(ctx: AccessContext, orgId: string): Promise<void> {
  assertCan(ctx, 'platform.orgs.manage');
  await callApi(ctx.db, 'request_deletion', { p_org: orgId }, ctx.requestId);
}

/** Undo a scheduled deletion within the thirty days (`api.cancel_deletion`). */
export async function restoreCompanyAsPlatform(ctx: AccessContext, orgId: string): Promise<void> {
  assertCan(ctx, 'platform.orgs.manage');
  await callApi(ctx.db, 'cancel_deletion', { p_org: orgId }, ctx.requestId);
}

/** The owner login of each listed company (ADR-167): the email the owner signs in with, and their name. */
export async function listCompanyOwners(ctx: AccessContext, orgIds: readonly string[]): Promise<Map<string, { email: string; fullName: string | null; count: number }>> {
  assertCan(ctx, 'platform.orgs.manage');
  const out = new Map<string, { email: string; fullName: string | null; count: number }>();
  if (orgIds.length === 0) return out;
  const rows = await callApi<Array<{ organization_id: string; email: string; full_name: string | null }>>(
    ctx.db, 'platform_company_owners', { p_orgs: orgIds }, ctx.requestId,
  );
  for (const r of rows ?? []) {
    const seen = out.get(r.organization_id);
    out.set(r.organization_id, seen ? { ...seen, count: seen.count + 1 } : { email: r.email, fullName: r.full_name, count: 1 });
  }
  return out;
}

/**
 * Change a company owner's sign-in email and/or password (ADR-167). `api.platform_owner_login_change`
 * authorises it (the super admin, recent sign-in, the single active owner, never a platform account,
 * an email no other login uses) and records it; the Auth admin API then makes the change, and the
 * owner's sessions are ended so the old details stop working everywhere at once. Returns the email
 * the owner now signs in with.
 */
export async function changeOwnerLoginAsPlatform(
  ctx: AccessContext, orgId: string, change: { readonly email: string; readonly password: string },
): Promise<string | null> {
  assertCan(ctx, 'platform.orgs.manage');
  const password = change.password;
  if (password && password.length < 8) throw new ValidationError('Use at least 8 characters for the owner\'s password.');
  if (password.length > 72) throw new ValidationError('Keep the owner\'s password under 72 characters.');
  const rows = await callApi<Array<{ user_id: string; email: string }>>(
    ctx.db, 'platform_owner_login_change', { p_org: orgId, p_new_email: change.email.trim(), p_password: Boolean(password) }, ctx.requestId,
  );
  const owner = (rows ?? [])[0];
  if (!owner) throw new NotFound();
  try {
    await updateLogin(owner.user_id, { email: owner.email, password: password || null });
  } catch (error) {
    throw new ValidationError(`The owner's login was not changed: ${(error as { message?: string } | null)?.message ?? 'unknown error'}`);
  }
  await revokeUserSessions(owner.user_id);
  return owner.email;
}

/**
 * Delete a company for good, now (ADR-168): for one already scheduled, skip the thirty days and run
 * the existing `org.purge` job straight away (rows, audit redaction, stored files). Cannot be undone.
 */
export async function purgeCompanyNowAsPlatform(ctx: AccessContext, orgId: string): Promise<void> {
  assertCan(ctx, 'platform.orgs.manage');
  await callApi(ctx.db, 'platform_purge_now', { p_org: orgId }, ctx.requestId);
}

