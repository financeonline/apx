import 'server-only';
import type { DocumentData } from 'firebase-admin/firestore';
import { globalRow, orgRow, type OrgTable } from '../schema';
import { uidOf, type Db } from '../types';
import { accessibleOrgRoles, orgRoleOf, type AccessibleOrg } from './access';

/**
 * Reads the AI Analyst needs that `src/db/rls.ts` does not offer yet (FIRESTORE_DATA_MODEL.md §5).
 *
 *  - `readableOrganization`: one `organizations` document under `organizations_select` (an
 *    organisation the caller can reach, by `accessible_org_roles`), or null — the facts the prompt,
 *    period resolution and the banking tools need (name, base currency, fiscal year).
 *  - `locateOrgRow`: which of the caller's organisations holds a row, by id alone. PostgreSQL could
 *    look a row up by its uuid across tenants (`api.archive_conversation(p_conversation)`, the
 *    feedback queue's detail page); Firestore keeps each organisation's rows under it, so the lookup
 *    probes the organisations the caller can reach — which is also exactly the old
 *    `v_org not in (select app.accessible_org_ids())` refusal. It returns WHERE the row is, never
 *    the row: the caller then reads it through `orgRowById` (the table's policy) or re-checks it
 *    with `requirePermission`, as the SQL did.
 */

/** `organizations_select`: the organisation's document when the caller can reach it, else null. */
export async function readableOrganization(db: Db, orgId: string | null): Promise<DocumentData | null> {
  if (!orgId) return null;
  const role = await orgRoleOf(db.fs, uidOf(db), orgId);
  if (!role) return null;
  const snap = await globalRow(db.fs, 'organizations', orgId).get();
  return snap.exists ? snap.data()! : null;
}

export interface ReachableOrganization extends AccessibleOrg {
  readonly name: string;
  readonly slug: string;
}

/**
 * The organisations the caller can reach, with the role (`app.accessible_org_roles()`) and the
 * name and slug a cross-organisation list prints — what an embedded `organizations(name, slug)`
 * returned under `organizations_select`.
 */
export async function reachableOrganizations(db: Db): Promise<ReachableOrganization[]> {
  const orgs = await accessibleOrgRoles(db.fs, uidOf(db));
  if (orgs.length === 0) return [];
  const snaps = await db.fs.getAll(...orgs.map((o) => globalRow(db.fs, 'organizations', o.organization_id)));
  return orgs.map((o, i) => ({
    ...o,
    name: String(snaps[i]?.get('name') ?? ''),
    slug: String(snaps[i]?.get('slug') ?? ''),
  }));
}

/**
 * The organisation (among those the caller can reach) whose `table` holds a row with this id, or
 * null — "does not exist" and "not yours" are the same answer (SECURITY_MODEL.md §14).
 */
export async function locateOrgRow(db: Db, table: OrgTable, id: string | null): Promise<string | null> {
  if (!id) return null;
  const orgs = await accessibleOrgRoles(db.fs, uidOf(db));
  if (orgs.length === 0) return null;
  const snaps = await db.fs.getAll(...orgs.map((o) => orgRow(db.fs, o.organization_id, table, id)));
  const hit = snaps.find((s) => s.exists);
  // The organisation is the document's parent in the path, not a field the row could misstate.
  return hit ? hit.ref.parent.parent!.id : null;
}
