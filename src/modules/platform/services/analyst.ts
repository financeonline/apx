import 'server-only';
import { revokeUserSessions } from '@/core/db';
import { callApi } from '@/core/db/api-rpc';
import { NotFound, ValidationError } from '@/core/errors';
import { updateLogin } from '@/db/app/platform-auth';
import type { Db } from '@/db/types';
import { DEPARTMENT_KEYS, SWITCHABLE_PERMISSIONS } from '@/modules/tenancy';

/**
 * ADR-187 (owner, 2026-11-05): a Financial Analyst creates companies and manages the ones they
 * created or the super admin gave them; the super admin sets each analyst's access per company.
 *
 * Every function here is a thin call: the authority is decided inside the `api.*` function
 * (`requireCompanyManager`, `requireSuperAdmin`), never by these services or the pages.
 */

interface Caller { readonly db: Db; readonly requestId: string }

export interface ManagedCompany {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  readonly countryCode: string | null;
  readonly baseCurrency: string;
  /** The analyst created it (no end date); otherwise the super admin gave it. */
  readonly createdByAnalyst: boolean;
  readonly endsAt: string | null;
  readonly owner: { readonly email: string; readonly fullName: string | null } | null;
}

/** The companies the signed-in analyst manages, with each one's owner login. */
export async function listManagedCompanies(caller: Caller): Promise<ManagedCompany[]> {
  const rows = await callApi<Array<Record<string, unknown>>>(caller.db, 'analyst_companies', {}, caller.requestId);
  const list = rows ?? [];
  const owners = list.length === 0 ? [] : await callApi<Array<{ organization_id: string; email: string; full_name: string | null }>>(
    caller.db, 'platform_company_owners', { p_orgs: list.map((r) => String(r.organization_id)) }, caller.requestId,
  );
  const ownerOf = new Map<string, { email: string; fullName: string | null }>();
  for (const o of owners ?? []) if (!ownerOf.has(o.organization_id)) ownerOf.set(o.organization_id, { email: o.email, fullName: o.full_name });
  return list.map((r) => ({
    id: String(r.organization_id), slug: String(r.slug), name: String(r.name), status: String(r.status),
    countryCode: (r.country_code as string | null) ?? null, baseCurrency: String(r.base_currency),
    createdByAnalyst: r.created_by_analyst === true, endsAt: (r.ends_at as string | null) ?? null,
    owner: ownerOf.get(String(r.organization_id)) ?? null,
  }));
}

/** Deactivate a company, or switch it back on. */
export async function setCompanyStatus(caller: Caller, orgId: string, active: boolean): Promise<void> {
  await callApi(caller.db, 'set_company_status', { p_org: orgId, p_status: active ? 'active' : 'suspended' }, caller.requestId);
}

/**
 * Change a company owner's sign-in email and/or password, as the super admin can (ADR-167): the
 * database authorises and records it, Firebase Auth makes it, and the owner's sessions end.
 */
export async function changeOwnerLogin(
  caller: Caller, orgId: string, change: { readonly email: string; readonly password: string },
): Promise<string> {
  const password = change.password;
  if (password && password.length < 8) throw new ValidationError("Use at least 8 characters for the owner's password.");
  if (password.length > 72) throw new ValidationError("Keep the owner's password under 72 characters.");
  const rows = await callApi<Array<{ user_id: string; email: string }>>(
    caller.db, 'platform_owner_login_change', { p_org: orgId, p_new_email: change.email.trim(), p_password: Boolean(password) }, caller.requestId,
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

export interface AnalystCompanyAccess {
  readonly organizationId: string;
  /** Null = every department the company has. */
  readonly departments: readonly string[] | null;
  readonly createdByAnalyst: boolean;
  readonly endsAt: string | null;
  /** The super admin's switches for this analyst in this company. */
  readonly switches: ReadonlyMap<string, boolean>;
}

/** The super admin's view of one analyst's access in each company they have. */
export async function loadAnalystAccess(caller: Caller, employeeUserId: string): Promise<AnalystCompanyAccess[]> {
  const rows = await callApi<Array<Record<string, unknown>>>(caller.db, 'analyst_access', { p_employee: employeeUserId }, caller.requestId);
  return (rows ?? []).map((r) => ({
    organizationId: String(r.organization_id),
    departments: Array.isArray(r.departments) ? (r.departments as string[]) : null,
    createdByAnalyst: r.created_by_analyst === true,
    endsAt: (r.ends_at as string | null) ?? null,
    switches: new Map(((r.switches as Array<{ permission: string; granted: boolean }>) ?? []).map((s) => [s.permission, s.granted])),
  }));
}

/**
 * Save one analyst's access in one company from the super admin's ticks: every permission whose tick
 * differs from the analyst's default becomes a switch, one that matches goes back to the default;
 * every department ticked means "all" (null), so departments the company switches on later are seen.
 */
export async function saveAnalystAccess(
  caller: Caller,
  input: {
    readonly organizationId: string; readonly employeeUserId: string;
    readonly departments: readonly string[]; readonly permissions: readonly string[];
    readonly analystDefaults: ReadonlySet<string>;
  },
): Promise<void> {
  const ticked = new Set(input.permissions);
  const switches = SWITCHABLE_PERMISSIONS.map((p) => ({
    permission: p, granted: ticked.has(p) === input.analystDefaults.has(p) ? null : ticked.has(p),
  }));
  const departments = (DEPARTMENT_KEYS as readonly string[]).every((d) => input.departments.includes(d))
    ? null
    : [...new Set(input.departments)];
  await callApi(caller.db, 'set_analyst_access', {
    p_org: input.organizationId, p_employee: input.employeeUserId, p_departments: departments, p_switches: switches,
  }, caller.requestId);
}
