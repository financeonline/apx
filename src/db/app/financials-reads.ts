import 'server-only';
import type { DocumentData, Query } from 'firebase-admin/firestore';
import { orgRows, orgRowById } from '../rls';
import { globalRow, orgCollection, orgRow, type OrgTable } from '../schema';
import { uidOf, type Db } from '../types';
import { orgRoleOf } from './access';

/**
 * Reads for the Financials, Banking, Commercial, Marketing and Budgets modules, for both kinds of
 * caller these modules serve (FIRESTORE_DATA_MODEL.md §2, §5):
 *
 *  - a person (`actor.kind === 'user'`): through `src/db/rls.ts`, so each table's policy decides
 *    what comes back, exactly as RLS did on the caller's client;
 *  - the server inside a job (`service`): the Admin SDK directly — the old service client — but only
 *    for the organisation the job is scoped to (a scoped handle reading another organisation gets
 *    nothing, as `motion/no-unscoped-service-query` and the `x-motion-org` scope intended).
 *
 * Anyone else (`anon`) reads nothing.
 */

function serviceMayRead(db: Db, orgId: string): boolean {
  return db.actor.kind === 'service' && (db.actor.scope === null || db.actor.scope === orgId);
}

/** The rows of `table` this caller may see, refined by the page's filters, order and limit. */
export async function readRows<T = DocumentData>(
  db: Db, orgId: string, table: OrgTable, refine?: (q: Query) => Query,
): Promise<T[]> {
  if (!orgId) return [];
  if (db.actor.kind === 'service') {
    if (!serviceMayRead(db, orgId)) return [];
    const base: Query = orgCollection(db.fs, orgId, table);
    const snap = await (refine ? refine(base) : base).get();
    return snap.docs.map((d) => d.data() as T);
  }
  return orgRows<T>(db, orgId, table, refine);
}

/** One row by id, or null when it does not exist or the caller may not see it. */
export async function readRowById<T = DocumentData>(db: Db, orgId: string, table: OrgTable, id: string): Promise<T | null> {
  if (!orgId || !id) return null;
  if (db.actor.kind === 'service') {
    if (!serviceMayRead(db, orgId)) return null;
    const snap = await orgRow(db.fs, orgId, table, id).get();
    return snap.exists ? (snap.data() as T) : null;
  }
  return orgRowById<T>(db, orgId, table, id);
}

/** Rows by id (any number; `in` takes at most 30, so this reads by document). */
export async function readRowsByIds<T = DocumentData>(db: Db, orgId: string, table: OrgTable, ids: readonly string[]): Promise<T[]> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return [];
  if (db.actor.kind === 'service') {
    if (!serviceMayRead(db, orgId)) return [];
    const snaps = await db.fs.getAll(...unique.map((id) => orgRow(db.fs, orgId, table, id)));
    return snaps.filter((s) => s.exists).map((s) => s.data() as T);
  }
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += 30) {
    out.push(...await orgRows<T>(db, orgId, table, (q) => q.where('id', 'in', unique.slice(i, i + 30))));
  }
  return out;
}

/**
 * The `organizations` row, as `organizations_select` admitted it: an organisation the person can
 * reach (any role), or the job's own organisation.
 */
export async function readOrganizationRow(db: Db, orgId: string): Promise<DocumentData | null> {
  if (!orgId) return null;
  if (db.actor.kind === 'service') {
    if (!serviceMayRead(db, orgId)) return null;
  } else if (!(await orgRoleOf(db.fs, uidOf(db), orgId))) {
    return null;
  }
  const snap = await globalRow(db.fs, 'organizations', orgId).get();
  return snap.exists ? snap.data()! : null;
}
