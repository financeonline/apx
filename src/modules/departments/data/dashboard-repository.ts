import 'server-only';
import { log } from '@/core/logging';
import { callApi } from '@/core/db';
import { orgQuery, orgRows, orgRowsByIds } from '@/db/rls';
import type { Db } from '@/db/types';

/**
 * Reads for the department dashboard's money departments and shared panels (ADR-180). Every read
 * is the caller's, through the read policies in `src/db/rls.ts`: a table they may not read counts
 * as empty, as RLS made it. Rows are read by document id where the ids are known (`orgRowsByIds`),
 * never with a `where('id', 'in', …)` per 30 ids — the emulator has no indexes and scans for each.
 */

/** Counterparty names by id; an id the caller may not read is absent. */
export async function counterpartyNames(db: Db, orgId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const rows = await orgRowsByIds<{ id: string; name: string | null }>(db, orgId, 'counterparties', ids);
  return new Map(rows.map((r) => [r.id, r.name ?? 'Unnamed customer']));
}

/** How many active bank accounts the caller can see (an aggregate count when the policy allows). */
export async function activeBankAccounts(db: Db, orgId: string): Promise<number> {
  const scoped = await orgQuery(db, orgId, 'bank_accounts');
  if (!scoped) return 0;
  if (scoped.keep) return (await orgRows(db, orgId, 'bank_accounts', (q) => q.where('is_active', '==', true))).length;
  return (await scoped.query.where('is_active', '==', true).count().get()).data().count;
}

export interface BatchFacts {
  /** `awaiting_review` batches: the uploads still to be checked. */
  readonly awaitingReview: number;
  /** Rows committed by committed batches (`row_counts.committed`, else `total`). */
  readonly recordsReceived: number;
  readonly committedBatches: number;
}

/**
 * The import batches' counts for the compliance checks and the workflow panel. Null when the caller
 * may not read imports (`imports.review`): a client is not told "0 uploads" about uploads it cannot see.
 */
export async function batchFacts(db: Db, orgId: string): Promise<BatchFacts | null> {
  const scoped = await orgQuery(db, orgId, 'import_batches');
  if (!scoped) return null;
  const rows = await orgRows<{ status: string; row_counts?: Record<string, unknown> | null }>(
    db, orgId, 'import_batches', (q) => q.where('status', 'in', ['awaiting_review', 'committed']),
  );
  let awaitingReview = 0, recordsReceived = 0, committedBatches = 0;
  for (const row of rows) {
    if (row.status === 'awaiting_review') awaitingReview += 1;
    if (row.status !== 'committed') continue;
    committedBatches += 1;
    const counts = row.row_counts ?? {};
    const n = typeof counts.committed === 'number' ? counts.committed : typeof counts.total === 'number' ? counts.total : 0;
    recordsReceived += n;
  }
  return { awaitingReview, recordsReceived, committedBatches };
}

/** The reader's own profile: name, email and time zone. */
export async function myProfile(db: Db, requestId?: string): Promise<{ fullName: string | null; email: string | null; timezone: string | null }> {
  const row = (await callApi<Array<{ full_name: string | null; email: string | null; timezone: string | null }>>(db, 'my_profile', {}, requestId))?.[0];
  return { fullName: row?.full_name ?? null, email: row?.email ?? null, timezone: row?.timezone ?? null };
}

/** When the reader signed in before this session's sign-in (`api.my_previous_sign_in`); null if never. */
export async function previousSignIn(db: Db, requestId?: string): Promise<string | null> {
  try {
    const rows = await callApi<Array<{ created_at: string }>>(db, 'my_previous_sign_in', {}, requestId);
    return rows?.[0]?.created_at ?? null;
  } catch (error) {
    // LAST LOGIN is a courtesy line: it must never take the dashboard down. On a project where the
    // `audit_events (actor_user_id, action, created_at desc)` index is not deployed yet the query is
    // refused; the line is then left out and the failure is logged for staff.
    log.warn('previous sign-in unavailable', { requestId, service: 'departments.dashboard', error: String(error) });
    return null;
  }
}
