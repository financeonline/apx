import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cache } from 'react';
import { createUserClient } from '@/core/db/user-client';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import { NotFound, toMotionError } from '@/core/errors';
import { newRequestId } from '@/core/logging';
import type { AccessContext } from '../context';
import type { ActorType, OrgStatus } from '../domain/types';
import { enabledModules } from '../domain/modules';

/**
 * Builds the AccessContext for a request (SERVICE_ARCHITECTURE.md §3).
 *
 * The role comes from api.my_context(), which uses app.accessible_org_roles() — the same function
 * RLS uses — so the application and the database cannot disagree at runtime. The organization is
 * addressed by the slug in the URL and is never taken from a request body (ADR-014).
 *
 * A caller with no access gets NotFound, never Forbidden: a 403 would confirm the organization
 * exists (SECURITY_MODEL.md §14).
 */

export interface SessionUser {
  readonly id: string;
  readonly email: string | null;
}

async function loadSessionUser(): Promise<SessionUser | null> {
  const db = await createUserClient();
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

interface MyContextRow {
  organization_id: string;
  slug: string;
  name: string;
  status: OrgStatus;
  role: EffectiveRole;
  actor_type: ActorType;
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
  const user = await loadSessionUser();
  if (!user) throw new NotFound();

  const db = await createUserClient();
  const { data, error } = await db.schema('api').rpc('my_context', { p_slug: orgSlug });
  if (error) throw toMotionError(error, requestId);

  const row = (data as MyContextRow[] | null)?.[0];
  if (!row || !row.role) throw new NotFound();

  // ADR-158: the systems the super admin switched on for this organisation.
  const { data: org } = await db.from('organizations').select('features').eq('id', row.organization_id).maybeSingle();
  const modules = enabledModules((org?.features ?? {}) as Record<string, unknown>);

  return {
    userId: user.id,
    orgId: row.organization_id,
    orgSlug: row.slug,
    effectiveRole: row.role,
    permissions: permissionsFor(row.role),
    actorType: row.actor_type,
    organizationStatus: row.status,
    modules,
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
export async function resolvePlatformRole(db: SupabaseClient, requestId?: string): Promise<EffectiveRole> {
  const { data, error } = await db.schema('api').rpc('my_platform_role');
  if (error) throw toMotionError(error, requestId);
  const row = (data as Array<{ platform_role: string; status: string }> | null)?.[0];
  if (row?.platform_role === 'super_admin' && row.status === 'active') return 'super_admin';
  if (row?.platform_role === 'employee' && row.status === 'active') return 'employee';
  return 'none';
}

/** Context with no organization, for /platform, /portfolio and /account. */
export const getPlatformContext = cache(async (): Promise<AccessContext> => {
  const requestId = newRequestId();
  const user = await loadSessionUser();
  if (!user) throw new NotFound();

  const db = await createUserClient();
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
