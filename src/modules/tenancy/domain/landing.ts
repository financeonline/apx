import { ROLE_MATRIX, type GrantedRole, type Permission } from '@/core/permissions';

/**
 * Where a person lands in a company.
 *
 * ADR-176 (owner, 2026-10-27): everyone lands on **Home, the client lobby** — the departments they
 * may open in a row at its top, the analysis beneath. Departments is one click away ("More apps").
 * Home asks only for `dashboard.view`, which every resolving role holds, so nobody lands on a
 * refusal. What follows is the earlier rule, kept for the Departments page's own redirect:
 *
 * (ADR-172 follow-up; the owner's earlier rule that signing in opens Departments.)
 *
 * Departments is the whole business at a glance, and every tile on it is the detail beneath a
 * section — it needs `financials.view`. A person without it (a 3rd party by default; a suspended
 * organisation's frozen Home; anyone whose figures switch was turned off) would land on a refusal,
 * so they land on **Home** instead: the overview they DO hold (headline figures, the Business
 * Health Score, their reports) and the "Request more information" card. An accountant holds
 * `financials.view` and lands on Departments like everyone else.
 *
 * Decided by PERMISSION, never by a role name (ADR-003), and in one place so the four callers that
 * send somebody into a company — `/select-organization`, accepting an invitation, the org layout's
 * logo link and the Departments page itself (the safety net for per-person switches, which the
 * role alone cannot see) — cannot disagree.
 */

export type LandingSection = 'departments' | 'home';

/** The permission Departments asks for; without it a person lands on Home. */
export const DEPARTMENTS_PERMISSION: Permission = 'financials.view';

/** The section a person lands on: the lobby, whatever they hold (ADR-176). */
export function landingSection(_permissions: ReadonlySet<Permission>): LandingSection {
  return 'home';
}

/** `/app/<slug>/departments` or `/app/<slug>/home`. */
export function landingPath(orgSlug: string, permissions: ReadonlySet<Permission>): string {
  return `/app/${orgSlug}/${landingSection(permissions)}`;
}

function isGrantedRole(role: string): role is GrantedRole {
  return Object.prototype.hasOwnProperty.call(ROLE_MATRIX, role);
}

/**
 * The landing when only the stored ROLE is known (`/select-organization` lists memberships, not
 * effective permissions): the role's defaults decide. A per-person switch can make that answer wrong
 * either way, and the Departments page corrects it — it sends anyone without `financials.view` to
 * Home — so this only saves the extra hop for the common case. An unknown role goes to Departments,
 * whose own check then decides.
 */
export function landingPathForRole(orgSlug: string, role: string): string {
  if (!isGrantedRole(role)) return `/app/${orgSlug}/home`;
  return landingPath(orgSlug, ROLE_MATRIX[role]);
}
