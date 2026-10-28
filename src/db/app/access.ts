import 'server-only';
import { ROLE_MATRIX, type EffectiveRole, type GrantedRole, type Permission } from '@/core/permissions';
import { raise } from '../raise';
import { globalRow, orgCollection, orgRow, overrideId } from '../schema';
import { readerOf, uidOf, type Db, type Reader } from '../types';
import type { Firestore, Transaction } from 'firebase-admin/firestore';

/**
 * Who may reach which organisation, and with what role — the TypeScript port of
 * `app.accessible_org_roles`, `app.org_role_of`, `app.effective_permission` and their helpers
 * (TENANCY_MODEL.md §3, ADR-044.4, ADR-172).
 *
 * This is the function every read and every write in `src/db` consults, as every RLS policy and
 * every `api.*` function consulted the SQL original. Resolution order, unchanged:
 *
 *   1. an active super admin reaches every organisation that is not deleted, as `super_admin`;
 *   2. an active platform employee reaches an organisation through an active, in-window
 *      assignment, as `employee` (`suspended_member` when the organisation is suspended);
 *   3. otherwise an active membership gives its role (`suspended_member` when suspended).
 *
 * A suspended MEMBERSHIP resolves to nothing; so does a deleted organisation.
 */

export type OrgRole = Exclude<EffectiveRole, 'none'>;

const REACHABLE: ReadonlySet<string> = new Set(['active', 'suspended', 'pending_deletion']);

interface PlatformUserDoc { platform_role: 'super_admin' | 'employee'; status: string }

export async function platformUserOf(fs: Firestore, userId: string, r: Reader): Promise<PlatformUserDoc | null> {
  const snap = await r.get(globalRow(fs, 'platform_users', userId));
  return snap.exists ? (snap.data() as PlatformUserDoc) : null;
}

export async function isSuperAdmin(fs: Firestore, userId: string | null, r: Reader = readerOf()): Promise<boolean> {
  if (!userId) return false;
  const p = await platformUserOf(fs, userId, r);
  return p?.platform_role === 'super_admin' && p.status === 'active';
}

export async function isPlatformUser(fs: Firestore, userId: string | null, r: Reader = readerOf()): Promise<boolean> {
  if (!userId) return false;
  const p = await platformUserOf(fs, userId, r);
  return p?.status === 'active';
}

/** `app.actor_type()`: how the audit log labels the caller. */
export async function actorTypeOf(
  fs: Firestore, userId: string | null, r: Reader = readerOf(),
): Promise<'system' | 'platform_admin' | 'employee' | 'user'> {
  if (!userId) return 'system';
  const p = await platformUserOf(fs, userId, r);
  if (p?.status === 'active' && p.platform_role === 'super_admin') return 'platform_admin';
  if (p?.status === 'active' && p.platform_role === 'employee') return 'employee';
  return 'user';
}

function inWindow(a: { starts_at?: string | null; ends_at?: string | null }, now: Date): boolean {
  const t = now.getTime();
  if (a.starts_at && new Date(a.starts_at).getTime() > t) return false;
  if (a.ends_at && new Date(a.ends_at).getTime() <= t) return false;
  return true;
}

/**
 * `app.org_role_of(actor, org)`: the actor's role in ONE organisation, or null. Four document reads,
 * no query, so it is cheap enough to run at the start of every write and inside its transaction.
 */
export async function orgRoleOf(
  fs: Firestore, actorId: string | null, orgId: string | null, r: Reader = readerOf(), now = new Date(),
): Promise<OrgRole | null> {
  if (!actorId || !orgId) return null;
  const [platform, orgSnap, assignment, membership] = await Promise.all([
    platformUserOf(fs, actorId, r),
    r.get(globalRow(fs, 'organizations', orgId)),
    r.get(orgRow(fs, orgId, 'organization_assignments', actorId)),
    r.get(orgRow(fs, orgId, 'organization_memberships', actorId)),
  ]);
  if (!orgSnap.exists) return null;
  const orgStatus = String(orgSnap.get('status'));

  if (platform?.status === 'active' && platform.platform_role === 'super_admin') {
    return orgStatus !== 'deleted' ? 'super_admin' : null;
  }
  const a = assignment.exists ? assignment.data()! : null;
  if (
    a && a.status === 'active' && platform?.status === 'active' && platform.platform_role === 'employee'
    && inWindow(a, now)
  ) {
    if (!REACHABLE.has(orgStatus)) return null;
    return orgStatus === 'suspended' ? 'suspended_member' : 'employee';
  }
  const m = membership.exists ? membership.data()! : null;
  if (!m || m.status !== 'active' || !REACHABLE.has(orgStatus)) return null;
  // An active assignment hides the membership (accessible_org_roles branch 3's NOT EXISTS).
  if (a && a.status === 'active') return null;
  return orgStatus === 'suspended' ? 'suspended_member' : (m.role as OrgRole);
}

/** `app.overridable_role`: the roles whose permissions can be switched per person (ADR-172). */
export function overridableRole(role: string | null): boolean {
  return role === 'admin' || role === 'accountant' || role === 'client' || role === 'third_party';
}

/** `app.effective_permission`: a per-person switch, else the role's row of the matrix. */
export async function effectivePermission(
  fs: Firestore, userId: string | null, orgId: string | null, role: string | null, perm: Permission,
  r: Reader = readerOf(),
): Promise<boolean> {
  if (!role || !userId || !orgId) return false;
  if (overridableRole(role)) {
    const o = await r.get(orgRow(fs, orgId, 'member_permission_overrides', overrideId(userId, perm)));
    if (o.exists) return o.get('granted') === true;
  }
  return ROLE_MATRIX[role as GrantedRole]?.has(perm) ?? false;
}

/** `app.has_permission_of(actor, org, perm)`. */
export async function hasPermissionOf(
  fs: Firestore, actorId: string | null, orgId: string, perm: Permission, r: Reader = readerOf(),
): Promise<boolean> {
  const role = await orgRoleOf(fs, actorId, orgId, r);
  return effectivePermission(fs, actorId, orgId, role, perm, r);
}

/**
 * `app.require_org(org)` for the calling user: their role, or NotFound — never PermissionDenied,
 * which would confirm the organisation exists (SECURITY_MODEL.md §14).
 */
export async function requireOrg(db: Db, orgId: string | null, tx?: Transaction): Promise<OrgRole> {
  const role = await orgRoleOf(db.fs, uidOf(db), orgId, readerOf(tx));
  if (!role) raise.notFound();
  return role;
}

/** `app.require_permission(org, perm)`: the caller's role when they hold `perm`. */
export async function requirePermission(
  db: Db, orgId: string | null, perm: Permission, tx?: Transaction,
): Promise<OrgRole> {
  const role = await requireOrg(db, orgId, tx);
  if (!(await effectivePermission(db.fs, uidOf(db), orgId, role, perm, readerOf(tx)))) {
    raise.denied(`${perm} is required`);
  }
  return role;
}

/** `app.has_permission(org, perm)` for the calling user. */
export async function hasPermission(db: Db, orgId: string, perm: Permission, tx?: Transaction): Promise<boolean> {
  return hasPermissionOf(db.fs, uidOf(db), orgId, perm, readerOf(tx));
}

export interface AccessibleOrg { readonly organization_id: string; readonly role: OrgRole }

/**
 * `app.accessible_org_roles()`: every organisation the user can reach, with the role. Needs two
 * collection-group queries (assignments, memberships), so pages call it once per request.
 */
export async function accessibleOrgRoles(fs: Firestore, userId: string | null, now = new Date()): Promise<AccessibleOrg[]> {
  if (!userId) return [];
  const platform = await platformUserOf(fs, userId, readerOf());
  if (platform?.status === 'active' && platform.platform_role === 'super_admin') {
    const orgs = await fs.collection('organizations').where('status', '!=', 'deleted').get();
    return orgs.docs.map((d) => ({ organization_id: d.id, role: 'super_admin' as const }));
  }

  const [assignments, memberships] = await Promise.all([
    fs.collectionGroup('organization_assignments').where('employee_user_id', '==', userId)
      .where('status', '==', 'active').get(),
    fs.collectionGroup('organization_memberships').where('user_id', '==', userId)
      .where('status', '==', 'active').get(),
  ]);
  const assigned = new Set(assignments.docs.map((d) => String(d.get('organization_id'))));
  const orgIds = [...new Set([
    ...assignments.docs.map((d) => String(d.get('organization_id'))),
    ...memberships.docs.map((d) => String(d.get('organization_id'))),
  ])];
  const orgSnaps = orgIds.length > 0 ? await fs.getAll(...orgIds.map((id) => globalRow(fs, 'organizations', id))) : [];
  const statusOf = new Map(orgSnaps.filter((s) => s.exists).map((s) => [s.id, String(s.get('status'))]));

  const out: AccessibleOrg[] = [];
  const employee = platform?.status === 'active' && platform.platform_role === 'employee';
  if (employee) {
    for (const a of assignments.docs) {
      const org = String(a.get('organization_id'));
      const status = statusOf.get(org);
      if (!status || !REACHABLE.has(status) || !inWindow(a.data(), now)) continue;
      out.push({ organization_id: org, role: status === 'suspended' ? 'suspended_member' : 'employee' });
    }
  }
  for (const m of memberships.docs) {
    const org = String(m.get('organization_id'));
    const status = statusOf.get(org);
    if (!status || !REACHABLE.has(status) || assigned.has(org)) continue;
    out.push({ organization_id: org, role: status === 'suspended' ? 'suspended_member' : (m.get('role') as OrgRole) });
  }
  return out;
}

/** `app.org_ids_with_permission(perm)`: the organisations where the user holds `perm`. */
export async function orgIdsWithPermission(fs: Firestore, userId: string | null, perm: Permission): Promise<string[]> {
  const roles = await accessibleOrgRoles(fs, userId);
  const out: string[] = [];
  for (const { organization_id, role } of roles) {
    if (await effectivePermission(fs, userId, organization_id, role, perm)) out.push(organization_id);
  }
  return out;
}

/** `app.adviser_org_ids()` / `app.portfolio_scope(orgs)`: where the user advises as platform staff. */
export async function adviserOrgIds(fs: Firestore, userId: string | null, only?: readonly string[] | null): Promise<string[]> {
  const roles = await accessibleOrgRoles(fs, userId);
  return roles
    .filter((r) => r.role === 'super_admin' || r.role === 'employee')
    .map((r) => r.organization_id)
    .filter((id) => !only || only.includes(id));
}

/** `app.switchable_permissions()`: the permissions an owner or admin may switch per person. */
export const SWITCHABLE_PERMISSIONS: readonly Permission[] = [
  'dashboard.view', 'financials.view', 'financials.edit', 'imports.create', 'imports.review',
  'banking.view', 'banking.reconcile', 'customers.view', 'customers.edit', 'reports.view',
  'reports.generate', 'ai.use', 'actions.view', 'actions.create', 'actions.assign',
  'actions.update_own', 'alerts.manage', 'intelligence.recompute', 'documents.view',
  'data.export', 'audit.view',
] as Permission[];

/** All memberships of one organisation (active or not): the team page and the last-owner guard. */
export function membershipsOf(fs: Firestore, orgId: string) {
  return orgCollection(fs, orgId, 'organization_memberships');
}

/**
 * `app.has_recent_auth(seconds)`: the caller proved who they are (signed in, or re-entered their
 * password) within the last `seconds`. Read from the session's `auth_time`, the Firebase equivalent
 * of the `amr` timestamp the JWT carried.
 */
export function hasRecentAuth(db: Db, seconds = 600): boolean {
  if (db.actor.kind !== 'user' || db.actor.authTime === null) return false;
  return db.actor.authTime >= Math.floor(Date.now() / 1000) - seconds;
}

/** `app.require_super_admin(reauth)`: an active super admin, and with `reauth` a recent sign-in. */
export async function requireSuperAdmin(db: Db, reauth = false, tx?: Transaction): Promise<void> {
  if (!(await isSuperAdmin(db.fs, uidOf(db), readerOf(tx)))) {
    raise.denied('platform administration requires the super admin');
  }
  if (reauth && !hasRecentAuth(db, 600)) {
    raise.denied('re-authenticate within the last 10 minutes to continue');
  }
}
