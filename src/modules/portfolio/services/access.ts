import 'server-only';
import { cache } from 'react';
import type { Db } from '@/db/types';
import { NotFound } from '@/core/errors';
import { newRequestId } from '@/core/logging';
import { createUserClient } from '@/core/db/user-client';
import { permissionsFor } from '@/core/permissions';
import { listMyOrganizations, resolvePlatformRole, type OrganizationSummary } from '@/modules/tenancy';
import { ADVISER_ROLES, type AdviserRole, type PortfolioOrganisation } from '../domain/types';

/**
 * Who may open the Command Centre, and over which organisations (ADR-112 §2).
 *
 * The set is `api.my_organizations()` — the database's own answer, derived from
 * `app.accessible_org_roles()`, the one source every RLS policy also reads — kept to the rows whose
 * role is one an adviser holds. A super admin reaches every organisation, an employee only
 * the ones assigned to them. The Command Centre is APX staff only (owner, 2026-10-14; ADR-112
 * addendum): a company membership — owner, admin, client or any company role — is not an adviser's,
 * so a company login resolves to nothing and gets the uniform 404, the same answer a stranger gets,
 * even over its own organisations. The database agrees: `app.adviser_org_ids()` and the analyst's
 * turn check accept only these two roles (20261018000030).
 *
 * Nothing is added here that the database did not already grant, and nothing decided here is
 * relied on alone: every read the portfolio makes puts these ids in its query AND is re-scoped by
 * the `api.portfolio_*` function to the caller's own adviser set.
 */

export interface PortfolioContext {
  readonly userId: string;
  readonly db: Db;
  readonly requestId: string;
  readonly organisations: readonly PortfolioOrganisation[];
  readonly organisationIds: readonly string[];
  readonly now: () => Date;
}

export function isAdviserRole(role: string): role is AdviserRole {
  return (ADVISER_ROLES as readonly string[]).includes(role);
}

/** The adviser-role subset of an accessible set. Pure, so the matrix test can drive it directly. */
export function adviserOrganisations(rows: readonly OrganizationSummary[]): PortfolioOrganisation[] {
  return rows
    .filter((row) => isAdviserRole(row.role))
    .map((row) => ({
      id: row.organizationId,
      slug: row.slug,
      name: row.name,
      status: row.status as PortfolioOrganisation['status'],
      role: row.role as AdviserRole,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolvePortfolioContext(
  db: Db, userId: string, requestId: string,
): Promise<PortfolioContext> {
  const rows = await listMyOrganizations(db);
  const organisations = adviserOrganisations(rows);
  if (organisations.length === 0) {
    /*
     * ADR-114 §6: an ACTIVE platform account with nothing to advise yet — an employee before
     * their first assignment — has an empty Command Centre, the state UX_ARCHITECTURE.md specifies,
     * not the uniform 404. Everyone else without a portfolio (a client-only member, a stranger, a
     * suspended or revoked employee) still gets NotFound.
     */
    const platformRole = await resolvePlatformRole(db, requestId);
    if (!permissionsFor(platformRole).has('assignments.view')) throw new NotFound();
  }
  return {
    userId,
    db,
    requestId,
    organisations,
    organisationIds: organisations.map((o) => o.id),
    now: () => new Date(),
  };
}

/** The request-scoped context for the `/portfolio` family. `NotFound` for anyone without a portfolio. */
export const getPortfolioContext = cache(async (): Promise<PortfolioContext> => {
  const db = await createUserClient();
  if (db.actor.kind !== 'user') throw new NotFound();
  return resolvePortfolioContext(db, db.actor.userId, newRequestId());
});
