import 'server-only';
import type { DocumentData, Query } from 'firebase-admin/firestore';
import { canReadGlobal, orgQuery, orgRows } from '../rls';
import { acrossOrgs, globalCollection, globalRow, type OrgTable } from '../schema';
import { uidOf, type Db } from '../types';
import { accessibleOrgRoles, adviserOrgIds, isSuperAdmin, orgRoleOf } from './access';

/**
 * The platform and portfolio pages' reads of TOP-LEVEL collections (FIRESTORE_DATA_MODEL.md §2, §5),
 * kept in `src/db` because only `src/db` may hold the Admin SDK (the
 * `motion/no-admin-sdk-outside-sanctioned-files` lint rule).
 *
 * On PostgreSQL these pages read `organizations`, `jobs`, `platform_users` and `platform_settings`
 * with the super admin's own JWT, and RLS decided what came back. The server now reads with the
 * Admin SDK, so the policy is applied here first, and a refused read is an EMPTY result, never an
 * error — what RLS did:
 *
 *  - `organizations_select`: the organisations in `app.accessible_org_roles()` — for the super admin
 *    every one that is not deleted;
 *  - `jobs_select`, `platform_settings_select`: the super admin; `platform_users_select`: the super
 *    admin (or one's own row) — `canReadGlobal`.
 */

/** One organisation, or null when it does not exist OR the caller cannot reach it (indistinguishable). */
export async function readableOrganization(db: Db, orgId: string): Promise<DocumentData | null> {
  if (!orgId || !(await orgRoleOf(db.fs, uidOf(db), orgId))) return null;
  const snap = await globalRow(db.fs, 'organizations', orgId).get();
  return snap.exists ? snap.data()! : null;
}

/** Every organisation the caller reaches (`organizations_select`). */
export async function readableOrganizations(db: Db): Promise<DocumentData[]> {
  const roles = await accessibleOrgRoles(db.fs, uidOf(db));
  if (roles.length === 0) return [];
  const snaps = await db.fs.getAll(...roles.map((r) => globalRow(db.fs, 'organizations', r.organization_id)));
  return snaps.filter((s) => s.exists).map((s) => s.data()!);
}

type GlobalReadable = 'jobs' | 'platform_settings' | 'platform_users';

/** The rows of a super-admin-only collection, refined by the page; empty for anyone else. */
export async function readGlobal(db: Db, table: GlobalReadable, refine?: (q: Query) => Query): Promise<DocumentData[]> {
  if (!(await canReadGlobal(db, table))) return [];
  if (table === 'platform_users' && !(await canReadGlobal(db, 'jobs'))) {
    // Not the super admin: `platform_users_select` admits one's own row only.
    const own = await globalRow(db.fs, 'platform_users', uidOf(db)!).get();
    return own.exists ? [own.data()!] : [];
  }
  const q: Query = globalCollection(db.fs, table);
  return (await (refine ? refine(q) : q).get()).docs.map((d) => d.data());
}

/** `select count(*)` of the same, under the same policy. */
export async function countGlobal(db: Db, table: GlobalReadable, refine?: (q: Query) => Query): Promise<number> {
  if (!(await canReadGlobal(db, 'jobs'))) {
    return table === 'platform_users' ? (await readGlobal(db, table)).length : 0;
  }
  const q: Query = globalCollection(db.fs, table);
  return (await (refine ? refine(q) : q).count().get()).data().count;
}

/** Organisation names for ids (the old `organizations(name)` embed): only the ones the caller reaches. */
export async function organizationNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const reachable = new Set((await accessibleOrgRoles(db.fs, uidOf(db))).map((r) => r.organization_id));
  const wanted = [...new Set(ids)].filter((id) => reachable.has(id));
  if (wanted.length === 0) return new Map();
  const snaps = await db.fs.getAll(...wanted.map((id) => globalRow(db.fs, 'organizations', id)));
  return new Map(snaps.filter((s) => s.exists).map((s) => [s.id, String(s.get('name'))]));
}

/**
 * Active adviser assignments across the platform, newest first (`assignments_select`: in a reachable
 * organisation, and for the super admin every one — for anyone else, their own).
 */
export async function readActiveAssignments(db: Db, limit: number): Promise<DocumentData[]> {
  const uid = uidOf(db);
  if (!uid) return [];
  const reachable = new Set((await accessibleOrgRoles(db.fs, uid)).map((r) => r.organization_id));
  if (reachable.size === 0) return [];
  let q: Query = acrossOrgs(db.fs, 'organization_assignments').where('status', '==', 'active');
  if (!(await isSuperAdmin(db.fs, uid))) q = q.where('employee_user_id', '==', uid);
  const snap = await q.orderBy('created_at', 'desc').limit(limit).get();
  return snap.docs.map((d) => d.data()).filter((a) => reachable.has(String(a.organization_id)));
}

/** `select count(*)` of one organisation's table, under its policy (a refused read counts 0). */
export async function countOrgRows(db: Db, orgId: string, table: OrgTable, refine?: (q: Query) => Query): Promise<number> {
  const scoped = await orgQuery(db, orgId, table);
  if (!scoped) return 0;
  if (scoped.keep) return (await orgRows(db, orgId, table, refine)).length;
  const q = refine ? refine(scoped.query) : scoped.query;
  return (await q.count().get()).data().count;
}

/**
 * The caller's own recent Command Centre turns, newest first, under `portfolio_ai_turns_select`
 * (`canReadPortfolioTurn`): the super admin's, or one's own within one's CURRENT adviser scope — a
 * turn about a client no longer advised is not shown. The scope is resolved once, not per turn.
 */
export async function ownPortfolioTurns(db: Db, limit: number): Promise<DocumentData[]> {
  const uid = uidOf(db);
  if (!uid) return [];
  const snap = await globalCollection(db.fs, 'portfolio_ai_turns')
    .where('user_id', '==', uid).orderBy('created_at', 'desc').limit(limit).get();
  const scope = (await isSuperAdmin(db.fs, uid)) ? null : new Set(await adviserOrgIds(db.fs, uid));
  return snap.docs.map((d) => d.data()).filter((row) => {
    const ids = Array.isArray(row.scope_organization_ids) ? (row.scope_organization_ids as string[]) : [];
    return scope === null || ids.every((id) => scope.has(id));
  });
}
