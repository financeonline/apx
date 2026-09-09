import 'server-only';
import { cache } from 'react';
import { createUserClient } from '@/core/db/user-client';
import { permissionsFor, type EffectiveRole, type Permission } from '@/core/permissions';
import { NotFound, toMotionError } from '@/core/errors';
import { newRequestId } from '@/core/logging';
import type { AccessContext } from '../context';
import type { ActorType, OrgStatus } from '../domain/types';

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

  return {
    userId: user.id,
    orgId: row.organization_id,
    orgSlug: row.slug,
    effectiveRole: row.role,
    permissions: permissionsFor(row.role),
    actorType: row.actor_type,
    organizationStatus: row.status,
    db,
    requestId,
    now: () => new Date(),
  };
}

/** Per-request memoisation: layout, page and server actions share one resolution. */
export const getAccessContext = cache(async (orgSlug: string): Promise<AccessContext> => {
  const requestId = newRequestId();
  const user = await loadSessionUser();
  if (!user) throw new NotFound();

  const db = await createUserClient();
  const { data, error } = await db.schema('api').rpc('my_context', { p_slug: orgSlug });
  if (error) throw toMotionError(error, requestId);

  const row = (data as MyContextRow[] | null)?.[0];
  if (!row || !row.role) throw new NotFound();

  const permissions: ReadonlySet<Permission> = permissionsFor(row.role);

  return {
    userId: user.id,
    orgId: row.organization_id,
    orgSlug: row.slug,
    effectiveRole: row.role,
    permissions,
    actorType: row.actor_type,
    organizationStatus: row.status,
    db,
    requestId,
    now: () => new Date(),
  };
});

/** Context with no organization, for /platform, /portfolio and /account. */
export const getPlatformContext = cache(async (): Promise<AccessContext> => {
  const requestId = newRequestId();
  const user = await loadSessionUser();
  if (!user) throw new NotFound();

  const db = await createUserClient();
  const { data, error } = await db.schema('api').rpc('my_platform_role');
  if (error) throw toMotionError(error, requestId);

  const row = (data as Array<{ platform_role: string; status: string; has_aal2: boolean }> | null)?.[0];
  const isActiveSuperAdmin =
    row?.platform_role === 'super_admin' && row.status === 'active' && row.has_aal2;
  const isActiveEmployee =
    row?.platform_role === 'employee' && row.status === 'active' && row.has_aal2;

  const effectiveRole: EffectiveRole = isActiveSuperAdmin
    ? 'super_admin'
    : isActiveEmployee
      ? 'employee'
      : 'none';

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
