import 'server-only';
import { cache } from 'react';
import { callApi } from '@/core/db/api-rpc';
import { createUserClient } from '@/core/db/user-client';
import type { Db } from '@/db/types';
import { permissionsFor, type EffectiveRole, type Permission } from '@/core/permissions';
import { NotFound } from '@/core/errors';
import { log, newRequestId } from '@/core/logging';
import type { AccessContext } from '../context';
import type { ActorType, OrgStatus } from '../domain/types';
import { enabledModules, type ModuleKey } from '../domain/modules';
import { DEPARTMENT_KEYS, isDepartmentKey, type DepartmentKey } from '../domain/member-access';
import { agreedPermissions } from '../domain/permissions';

/**
 * Builds the AccessContext for a request (SERVICE_ARCHITECTURE.md §3).
 *
 * The role comes from api.my_access() (api.my_context() plus the per-person switches, ADR-172), which
 * uses `orgRoleOf` (`src/db/app/access.ts`) — the same resolution every read policy in `src/db/rls.ts`
 * and every `api.*` function uses — so the application and the data layer cannot disagree at runtime. The organization is
 * addressed by the slug in the URL and is never taken from a request body (ADR-014).
 *
 * A caller with no access gets NotFound, never Forbidden: a 403 would confirm the organization
 * exists (SECURITY_MODEL.md §14).
 */

export interface SessionUser {
  readonly id: string;
  readonly email: string | null;
}

/** The signed-in person a database handle carries, or null (anon, service). */
export function sessionUserOf(db: Db): SessionUser | null {
  return db.actor.kind === 'user' ? { id: db.actor.userId, email: db.actor.email } : null;
}

/**
 * The signed-in person of this request, from the verified `__session` cookie (revocation checked),
 * or null. The replacement for `supabase.auth.getUser()` in pages and routes.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => sessionUserOf(await createUserClient()));

interface MyAccessRow {
  organization_id: string;
  slug: string;
  name: string;
  status: OrgStatus;
  role: EffectiveRole;
  actor_type: ActorType;
  features: Record<string, unknown> | null;
  overrides: unknown;
  permissions: string[] | null;
  departments: string[] | null;
}

/**
 * ADR-173: a member's departments narrow the company's systems for that person. A system that is not
 * a department (none today) is untouched; a department not ticked is absent, as a system switched
 * off for the company is. NULL = all of the company's.
 */
export function narrowToDepartments(
  modules: ReadonlySet<ModuleKey>,
  departments: readonly DepartmentKey[] | null,
): ReadonlySet<ModuleKey> {
  if (departments === null) return modules;
  const allowed = new Set<ModuleKey>(departments);
  const departmentKeys = new Set<ModuleKey>(DEPARTMENT_KEYS);
  return new Set([...modules].filter((key) => !departmentKeys.has(key) || allowed.has(key)));
}

/** Logs a disagreement between the TypeScript and SQL twins; the caller keeps only what both grant. */
function effectivePermissionsFrom(
  role: EffectiveRole,
  rawOverrides: unknown,
  databasePermissions: readonly string[] | null,
  requestId?: string,
): ReadonlySet<Permission> {
  const result = agreedPermissions(role, rawOverrides, databasePermissions);
  if (result.onlyComputed.length > 0 || result.onlyDatabase.length > 0) {
    log.warn('tenancy.permissions_disagree', {
      requestId, role, onlyComputed: result.onlyComputed, onlyDatabase: result.onlyDatabase,
    });
  }
  return result.agreed;
}

/**
 * Resolves the caller's access to an organisation, uncached.
 *
 * `getAccessContext` below memoises this per request, which is right for a page: the layout, the
 * page and its server actions share one resolution. It is WRONG for the one caller that must see a
 * change mid-request — the analyst's tool loop re-resolves before every tool call so that a
 * demotion during a 45 s turn aborts it (AI_ARCHITECTURE.md §4, F-C-17), and a memoised answer
 * would defeat that silently. That caller uses this function.
 */
export async function resolveAccessFresh(orgSlug: string): Promise<AccessContext> {
  const requestId = newRequestId();
  const db = await createUserClient();
  const user = sessionUserOf(db);
  if (!user) throw new NotFound();

  /*
   * ONE round trip (ADR-172): the role, as api.my_context resolves it through the same
   * app.accessible_org_roles() every policy uses; the organisation's systems (ADR-158); the caller's
   * per-person switches; and the effective permissions the database computes from them. Nothing is
   * looked up again per check — `can(ctx, …)` reads the set built here.
   */
  const rows = await callApi<MyAccessRow[] | null>(db, 'my_access', { p_slug: orgSlug }, requestId);
  const row = rows?.[0];
  if (!row || !row.role) throw new NotFound();

  // ADR-158: the systems the super admin switched on for this organisation; ADR-173: narrowed to the
  // departments this member was given.
  const departments = Array.isArray(row.departments) ? row.departments.filter(isDepartmentKey) : null;
  const modules = narrowToDepartments(enabledModules((row.features ?? {}) as Record<string, unknown>), departments);

  return {
    userId: user.id,
    orgId: row.organization_id,
    orgSlug: row.slug,
    effectiveRole: row.role,
    permissions: effectivePermissionsFrom(row.role, row.overrides, row.permissions, requestId),
    actorType: row.actor_type,
    organizationStatus: row.status,
    modules,
    departments,
    db,
    requestId,
    now: () => new Date(),
  };
}

/**
 * Per-request memoisation: layout, page and server actions share one resolution.
 *
 * Deliberately `cache(resolveAccessFresh)` and not a second copy of the body (ADR-094). The two were
 * written out twice, which means a correction to how access is resolved — the one function that
 * decides what every request may see — had to be made in two places or it was made in none.
 */
export const getAccessContext = cache(resolveAccessFresh);

/**
 * The caller's platform role, from the database: `super_admin` or `employee` for an ACTIVE platform
 * account, else `none`. The same rule `getPlatformContext` applies, callable with any client
 * (the Command Centre's resolver and its tests pass their own).
 */
export async function resolvePlatformRole(db: Db, requestId?: string): Promise<EffectiveRole> {
  const rows = await callApi<Array<{ platform_role: string; status: string }> | null>(db, 'my_platform_role', {}, requestId);
  const row = rows?.[0];
  if (row?.platform_role === 'super_admin' && row.status === 'active') return 'super_admin';
  if (row?.platform_role === 'employee' && row.status === 'active') return 'employee';
  return 'none';
}

/** Context with no organization, for /platform, /portfolio and /account. */
export const getPlatformContext = cache(async (): Promise<AccessContext> => {
  const requestId = newRequestId();
  const db = await createUserClient();
  const user = sessionUserOf(db);
  if (!user) throw new NotFound();

  const effectiveRole = await resolvePlatformRole(db, requestId);
  const isActiveSuperAdmin = effectiveRole === 'super_admin';
  const isActiveEmployee = effectiveRole === 'employee';

  return {
    userId: user.id,
    orgId: null,
    orgSlug: null,
    effectiveRole,
    permissions: permissionsFor(effectiveRole),
    actorType: isActiveSuperAdmin ? 'platform_admin' : isActiveEmployee ? 'employee' : 'user',
    organizationStatus: null,
    db,
    requestId,
    now: () => new Date(),
  };
});
