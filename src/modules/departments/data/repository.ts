import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';

/** Reads for the departmental overview (ADR-143). Counts and latest rows only; nothing is written. */

async function count(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  const { count: n, error } = await query;
  if (error) throw toMotionError(error);
  return n ?? 0;
}

export async function alertCounts(db: SupabaseClient, orgId: string): Promise<Record<'critical' | 'high' | 'other', number>> {
  const base = () => db.from('alerts').select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId).in('status', ['open', 'acknowledged']);
  const [critical, high, all] = await Promise.all([
    count(base().eq('severity', 'critical')),
    count(base().eq('severity', 'high')),
    count(base()),
  ]);
  return { critical, high, other: Math.max(0, all - critical - high) };
}

export async function bankFacts(db: SupabaseClient, orgId: string): Promise<{ accounts: number; statementsReach: string | null }> {
  const accounts = await count(db.from('bank_accounts').select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId).eq('is_active', true));
  const { data, error } = await db.from('import_batches').select('period_end')
    .eq('organization_id', orgId).eq('import_type', 'bank_statement').eq('status', 'committed')
    .not('period_end', 'is', null).order('period_end', { ascending: false }).limit(1);
  if (error) throw toMotionError(error);
  return { accounts, statementsReach: (data?.[0] as { period_end?: string } | undefined)?.period_end ?? null };
}

export async function latestRun(db: SupabaseClient, orgId: string): Promise<{
  status: string; finishedAt: string | null; engineVersion: string | null; asOf: string | null;
} | null> {
  const { data, error } = await db.from('calculation_runs').select('status, finished_at, engine_version, as_of, started_at')
    .eq('organization_id', orgId).order('started_at', { ascending: false }).limit(1);
  if (error) throw toMotionError(error);
  const row = data?.[0] as { status: string; finished_at: string | null; engine_version: string | null; as_of: string | null } | undefined;
  return row === undefined ? null : { status: row.status, finishedAt: row.finished_at, engineVersion: row.engine_version, asOf: row.as_of };
}

export async function importCounts(db: SupabaseClient, orgId: string): Promise<{ awaitingReview: number; failed: number }> {
  const [awaitingReview, failed] = await Promise.all([
    count(db.from('import_batches').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('status', 'awaiting_review')),
    count(db.from('import_batches').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('status', 'failed')),
  ]);
  return { awaitingReview, failed };
}

export async function organisationFeatures(db: SupabaseClient, orgId: string): Promise<Record<string, boolean>> {
  const { data, error } = await db.from('organizations').select('features').eq('id', orgId).maybeSingle();
  if (error) throw toMotionError(error);
  const features = ((data as { features?: Record<string, unknown> } | null)?.features ?? {});
  return Object.fromEntries(Object.entries(features).map(([k, v]) => [k, v === true]));
}

export async function budgetMonths(db: SupabaseClient, orgId: string): Promise<number> {
  const { data, error } = await db.from('budget_lines').select('period_id')
    .eq('organization_id', orgId).eq('record_status', 'accepted').is('superseded_by', null).limit(5000);
  if (error) throw toMotionError(error);
  return new Set(((data ?? []) as Array<{ period_id: string }>).map((r) => r.period_id)).size;
}
