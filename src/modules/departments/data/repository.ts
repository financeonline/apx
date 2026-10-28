import 'server-only';
import type { Query } from 'firebase-admin/firestore';
import { orgQuery, orgRows } from '@/db/rls';
import type { OrgTable } from '@/db/schema';
import type { Db } from '@/db/types';
import { organizationDoc } from '@/modules/tenancy';

/**
 * Reads for the departmental overview (ADR-143). Counts and latest rows only; nothing is written.
 * Every read is the caller's, through the read policies in `src/db/rls.ts` (a table they may not
 * read counts as empty, as RLS made it).
 */

/** `select count(*)` under the caller's policy: an aggregate query when the policy is a plain filter. */
async function count(db: Db, orgId: string, table: OrgTable, refine: (q: Query) => Query): Promise<number> {
  const scoped = await orgQuery(db, orgId, table);
  if (!scoped) return 0;
  if (scoped.keep) return (await orgRows(db, orgId, table, refine)).length;
  const snap = await refine(scoped.query).count().get();
  return snap.data().count;
}

export async function alertCounts(db: Db, orgId: string): Promise<Record<'critical' | 'high' | 'other', number>> {
  const base = (q: Query) => q.where('status', 'in', ['open', 'acknowledged']);
  const [critical, high, all] = await Promise.all([
    count(db, orgId, 'alerts', (q) => base(q).where('severity', '==', 'critical')),
    count(db, orgId, 'alerts', (q) => base(q).where('severity', '==', 'high')),
    count(db, orgId, 'alerts', base),
  ]);
  return { critical, high, other: Math.max(0, all - critical - high) };
}

export async function bankFacts(db: Db, orgId: string): Promise<{ accounts: number; statementsReach: string | null }> {
  const accounts = await count(db, orgId, 'bank_accounts', (q) => q.where('is_active', '==', true));
  // The latest committed statement's end; computed here rather than ordered in the query, so no
  // composite index is needed (a company has tens of statements, not thousands).
  const batches = await orgRows<{ period_end: string | null }>(db, orgId, 'import_batches', (q) => q
    .where('import_type', '==', 'bank_statement').where('status', '==', 'committed'));
  const reach = batches.map((b) => b.period_end).filter((d): d is string => typeof d === 'string').sort().at(-1) ?? null;
  return { accounts, statementsReach: reach };
}

export async function latestRun(db: Db, orgId: string): Promise<{
  status: string; finishedAt: string | null; engineVersion: string | null; asOf: string | null;
} | null> {
  const rows = await orgRows<{ status: string; finished_at: string | null; engine_version: string | null; as_of: string | null }>(
    db, orgId, 'calculation_runs', (q) => q.orderBy('started_at', 'desc').limit(1),
  );
  const row = rows[0];
  return row === undefined ? null : {
    status: row.status, finishedAt: row.finished_at ?? null, engineVersion: row.engine_version ?? null, asOf: row.as_of ?? null,
  };
}

export async function importCounts(db: Db, orgId: string): Promise<{ awaitingReview: number; failed: number }> {
  const [awaitingReview, failed] = await Promise.all([
    count(db, orgId, 'import_batches', (q) => q.where('status', '==', 'awaiting_review')),
    count(db, orgId, 'import_batches', (q) => q.where('status', '==', 'failed')),
  ]);
  return { awaitingReview, failed };
}

export async function organisationFeatures(db: Db, orgId: string): Promise<Record<string, boolean>> {
  const org = await organizationDoc(db, orgId);
  const features = (org?.features as Record<string, unknown> | undefined) ?? {};
  return Object.fromEntries(Object.entries(features).map(([k, v]) => [k, v === true]));
}

export async function budgetMonths(db: Db, orgId: string): Promise<number> {
  const rows = await orgRows<{ period_id: string }>(db, orgId, 'budget_lines', (q) => q
    .where('record_status', '==', 'accepted').where('superseded_by', '==', null).limit(5000));
  return new Set(rows.map((r) => r.period_id)).size;
}

/** The organisation's timezone and currency, as the caller may read them. */
export async function organisationBasics(db: Db, orgId: string): Promise<{ timezone: string; currency: string }> {
  const org = await organizationDoc(db, orgId);
  return {
    timezone: (org?.timezone as string | undefined) ?? 'Europe/London',
    currency: (org?.base_currency as string | undefined) ?? 'GBP',
  };
}
