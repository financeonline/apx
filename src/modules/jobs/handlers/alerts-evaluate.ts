import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { persistAlerts } from '@/core/db';
import { evaluateAlerts } from '@/modules/alerts';
import { loadBankRecords, loadObservations, loadRecurringGroups } from '@/modules/health';
import type { ClaimedJob, JobOutcome } from '../domain/types';

/**
 * `alerts.evaluate` (FINANCIAL_ENGINE.md §8.3).
 *
 * Runs after a successful calculation, against the run whose id is in the payload. The RUN is what
 * decides which periods are evaluated and at what instant, so a re-queued job evaluates exactly the
 * same set — the retry is idempotent because the run it names has not moved.
 *
 * The record and snapshot reads are the health module's, deliberately: §8.3 requires the score and
 * the alerts to see the same rows, and two repositories reading "accepted, not superseded, as of
 * this instant" separately is two chances to disagree about what that means.
 */
export async function evaluateAlertsJob(
  job: ClaimedJob,
  scope: { db: unknown },
): Promise<JobOutcome> {
  const orgId = job.organizationId;
  if (orgId === null) {
    return { status: 'failed', error: 'alerts.evaluate has no organization to scope to' };
  }

  const runId = typeof job.payload.run_id === 'string' ? job.payload.run_id : null;
  if (runId === null) {
    return { status: 'failed', error: 'alerts.evaluate needs the run it is evaluating' };
  }

  const scoped = scope.db as SupabaseClient;

  const run = await loadRun(scoped, orgId, runId);
  if (run === null) {
    // The run was purged, or the payload names one from another organisation — which RLS has
    // already made invisible. Either way there is nothing to evaluate, and failing would retry for
    // ever against a row that will never appear.
    return { status: 'succeeded', result: { skipped: 'run not found', run_id: runId } };
  }

  const periods = await loadRunPeriods(scoped, orgId, run.periodFrom, run.periodTo);
  const window = await loadWindow(scoped, orgId, run.periodFrom, run.periodTo);
  const settings = await loadSettings(scoped, orgId);
  const firstPeriodWithDataId = window[0]?.id ?? null;

  const outcome = await evaluateAlerts({
    scoped,
    persistAlerts,
    loadObservations: (periodIds) => loadObservations(scoped, orgId, periodIds),
    loadBankRecords: (periodIds, aggregatedAt) =>
      loadBankRecords(scoped, orgId, periodIds, aggregatedAt),
    loadRecurringGroups: () => loadRecurringGroups(scoped, orgId),
    loadAccounts: () => loadAccounts(scoped, orgId),
    loadCounterparties: () => loadCounterparties(scoped, orgId),
  }, {
    organizationId: orgId,
    calculationRunId: runId,
    periods,
    windowPeriodIds: window.map((p) => p.id),
    aggregatedAt: run.aggregatedAt,
    currency: settings.currency,
    firstPeriodWithDataId,
    // The ONE clock read in the alert engine, and it exists only for the ninety-day dismissal
    // cooldown (§8.1). Everything else is a function of the data.
    now: new Date().toISOString(),
  });

  return { status: 'succeeded', result: { ...outcome } };
}

interface RunRow {
  period_from: string;
  period_to: string;
  started_at: string;
  finished_at: string | null;
  chunks: Array<{ aggregated_at?: string | null }> | null;
}

async function loadRun(
  db: SupabaseClient, orgId: string, runId: string,
): Promise<{ periodFrom: string; periodTo: string; aggregatedAt: string } | null> {
  const { data } = await db
    .from('calculation_runs')
    .select('period_from, period_to, started_at, finished_at, chunks')
    .eq('organization_id', orgId)
    .eq('id', runId)
    .maybeSingle();

  const row = data as RunRow | null;
  if (row === null) return null;

  /*
   * The instant the alert pass reads records at: the EARLIEST `aggregated_at` of this run's chunks
   * (§8.3, ADR-063).
   *
   * It used to be `finished_at ?? started_at`, and `finished_at` is strictly after every chunk
   * aggregated — so a row committed while the run was in flight was invisible to every snapshot the
   * run wrote and visible to the rules judging them. An alert would then fire on a transaction the
   * figure it cites does not contain, which is the one thing an alert must never do: §8.3 evaluates
   * the rules against the run's own view of the data.
   *
   * The earliest chunk instant is the only single value that cannot admit such a row, because
   * anything visible then was visible to every later chunk as well. Where a run spans several chunks
   * this is conservative for the later ones — a rule may miss a row a later chunk did see — and
   * that asymmetry is deliberate: a missed alert is a smaller failure than one that cites a figure
   * contradicting it.
   */
  const instants = (row.chunks ?? [])
    .map((chunk) => chunk.aggregated_at)
    .filter((instant): instant is string => typeof instant === 'string' && instant !== '')
    .sort();

  return {
    periodFrom: row.period_from,
    periodTo: row.period_to,
    // A run with no recorded chunk aggregated nothing; `started_at` is then the only honest answer,
    // and it is the same clock (ADR-063).
    aggregatedAt: instants[0] ?? row.started_at,
  };
}

interface PeriodRow {
  id: string;
  period_start: string;
  period_end: string;
  is_complete: boolean;
}

/** The periods the run wrote, oldest first (§8.3 "for P in periods ascending"). */
async function loadRunPeriods(
  db: SupabaseClient, orgId: string, from: string, to: string,
): Promise<Array<{ id: string; periodStart: string; periodEnd: string; isComplete: boolean }>> {
  const bounds = await periodBounds(db, orgId, from, to);
  if (bounds === null) return [];
  const { data } = await db
    .from('fiscal_periods')
    .select('id, period_start, period_end, is_complete')
    .eq('organization_id', orgId)
    .gte('period_start', bounds.from)
    .lte('period_start', bounds.to)
    .order('period_start', { ascending: true });

  return ((data ?? []) as PeriodRow[]).map((row) => ({
    id: row.id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    isComplete: row.is_complete,
  }));
}

/** The run's periods plus twelve months of lookback, which the trailing rules walk. */
async function loadWindow(
  db: SupabaseClient, orgId: string, from: string, to: string,
): Promise<Array<{ id: string; periodStart: string }>> {
  const bounds = await periodBounds(db, orgId, from, to);
  if (bounds === null) return [];
  const { data } = await db
    .from('fiscal_periods')
    .select('id, period_start')
    .eq('organization_id', orgId)
    .lte('period_start', bounds.to)
    .order('period_start', { ascending: true });

  const rows = ((data ?? []) as Array<{ id: string; period_start: string }>).map((row) => ({
    id: row.id, periodStart: row.period_start,
  }));
  const firstIndex = rows.findIndex((row) => row.periodStart >= bounds.from);
  const start = firstIndex < 0 ? 0 : Math.max(0, firstIndex - 12);
  return rows.slice(start);
}

async function periodBounds(
  db: SupabaseClient, orgId: string, from: string, to: string,
): Promise<{ from: string; to: string } | null> {
  const { data } = await db
    .from('fiscal_periods')
    .select('id, period_start')
    .eq('organization_id', orgId)
    .in('id', [from, to]);

  const rows = (data ?? []) as Array<{ id: string; period_start: string }>;
  const start = rows.find((row) => row.id === from)?.period_start;
  const end = rows.find((row) => row.id === to)?.period_start;
  if (start === undefined || end === undefined) return null;
  return start <= end ? { from: start, to: end } : { from: end, to: start };
}

async function loadAccounts(
  db: SupabaseClient, orgId: string,
): Promise<Array<{ id: string; name: string; standardCategory: string }>> {
  const { data } = await db
    .from('accounts')
    .select('id, name, standard_category')
    .eq('organization_id', orgId);
  return ((data ?? []) as Array<{ id: string; name: string; standard_category: string }>)
    .map((row) => ({ id: row.id, name: row.name, standardCategory: row.standard_category }));
}

async function loadCounterparties(
  db: SupabaseClient, orgId: string,
): Promise<Array<{ id: string; name: string }>> {
  const { data } = await db
    .from('counterparties')
    .select('id, name')
    .eq('organization_id', orgId);
  return (data ?? []) as Array<{ id: string; name: string }>;
}

async function loadSettings(
  db: SupabaseClient, orgId: string,
): Promise<{ currency: string }> {
  const { data } = await db
    .from('organizations')
    .select('base_currency')
    .eq('id', orgId)
    .maybeSingle();
  return { currency: (data as { base_currency?: string } | null)?.base_currency ?? 'GBP' };
}
