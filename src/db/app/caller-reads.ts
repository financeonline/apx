import 'server-only';
import type { DocumentData, Query } from 'firebase-admin/firestore';
import { orgRoleOf } from './access';
import { orgRowById, orgRows } from '../rls';
import { globalRow, orgCollection, orgRow, type OrgTable } from '../schema';
import type { Db } from '../types';

/**
 * Reads that run for EITHER caller the reporting, investment and export modules are handed
 * (FIRESTORE_DATA_MODEL.md §2, §5):
 *
 *  - a person's handle (a page, a live preview): through `src/db/rls.ts`, so every policy holds —
 *    `reports` and `report_files` filter rows by kind and author there, exactly as RLS did;
 *  - a job's scoped service handle (`withOrgScope`; the report render, the stored brief, the
 *    investment pack): the server itself, which on PostgreSQL read with the service role and so
 *    past RLS. It reads the named organisation directly — and ONLY the organisation it is scoped
 *    to, so a handler that names the wrong one reads nothing (ADR-090).
 *
 * A refused read is empty, never an error, as before.
 */

function serviceMayRead(db: Db, orgId: string): boolean {
  return db.actor.kind === 'service' && (db.actor.scope === null || db.actor.scope === orgId);
}

/** The caller's rows of one organisation table; `refine` adds filters, order and limit. */
export async function readRows<T = DocumentData>(
  db: Db, orgId: string, table: OrgTable, refine?: (q: Query) => Query,
): Promise<T[]> {
  if (db.actor.kind === 'service') {
    if (!serviceMayRead(db, orgId)) return [];
    const base: Query = orgCollection(db.fs, orgId, table);
    const snap = await (refine ? refine(base) : base).get();
    return snap.docs.map((d) => d.data() as T);
  }
  return orgRows<T>(db, orgId, table, refine);
}

/** One row by id, or null when it does not exist or the caller may not see it. */
export async function readRowById<T = DocumentData>(
  db: Db, orgId: string, table: OrgTable, id: string,
): Promise<T | null> {
  if (!id) return null;
  if (db.actor.kind === 'service') {
    if (!serviceMayRead(db, orgId)) return null;
    const snap = await orgRow(db.fs, orgId, table, id).get();
    return snap.exists ? (snap.data() as T) : null;
  }
  return orgRowById<T>(db, orgId, table, id);
}

/** Many rows by id (any number), joined in TypeScript — the port of a PostgREST embedded select. */
export async function readRowsByIds<T = DocumentData>(
  db: Db, orgId: string, table: OrgTable, ids: readonly (string | null | undefined)[],
): Promise<T[]> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const out: T[] = [];
  // `in` takes at most 30 values (FIRESTORE_DATA_MODEL.md §5).
  for (let i = 0; i < unique.length; i += 30) {
    const chunk = unique.slice(i, i + 30);
    out.push(...await readRows<T>(db, orgId, table, (q) => q.where('id', 'in', chunk)));
  }
  return out;
}

/**
 * The `organizations` row (`organizations_select`: any organisation the person can reach), or
 * null. A scoped service handle reads its own organisation.
 */
export async function readOrganization(db: Db, orgId: string): Promise<DocumentData | null> {
  if (!orgId) return null;
  if (db.actor.kind === 'service') {
    if (!serviceMayRead(db, orgId)) return null;
  } else if (db.actor.kind !== 'user' || (await orgRoleOf(db.fs, db.actor.userId, orgId)) === null) {
    return null;
  }
  const snap = await globalRow(db.fs, 'organizations', orgId).get();
  return snap.exists ? snap.data()! : null;
}
