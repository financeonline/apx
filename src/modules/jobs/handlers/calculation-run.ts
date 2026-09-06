import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  enqueueServerJob, finishCalculationRun, finishChunk, finishHealth, setPeriodCompleteness,
  startCalculationRun,
} from '@/core/db';
import {
  composePeriod, runCalculation,
  type AggregateCell, type CalculationTrigger, type EngineContext, type PeriodCoverage,
  type PeriodRef,
} from '@/modules/financial-engine';
import { healthStep } from '@/modules/health';
import type { ClaimedJob, JobOutcome } from '../domain/types';

/**
 * `calculation.run` (FINANCIAL_ENGINE.md §2.4).
 *
 * The handler is deliberately thin: every decision — the affected range, the chunking, the
 * fingerprint, the health step, the failed-run restore — is in `runCalculation`, which is pure of
 * I/O except through the dependencies passed here. This file exists to supply those dependencies
 * and nothing else, so the thing under test stays the run loop rather than a route.
 *
 * **The organisation comes from the job row, never the payload** — `withOrgScope` already applied it
 * before this function was called, and `job.organizationId` is what is passed on. A payload naming
 * another organisation achieves nothing (§4 case 14/19).
 */
export async function runCalculationJob(
  job: ClaimedJob,
  scope: { db: unknown },
): Promise<JobOutcome> {
  const orgId = job.organizationId;
  if (orgId === null) {
    return { status: 'failed', error: 'calculation.run has no organization to scope to' };
  }

  const scoped = scope.db as SupabaseClient;
  const payload = job.payload;

  const trigger = (typeof payload.trigger === 'string' ? payload.trigger : 'recalc_manual') as CalculationTrigger;

  /*
   * `app.enqueue_recalculation` writes `{trigger, triggerRefId}` and no period ids — for an import
   * that ref is the BATCH, and the periods it touched are a property of the batch rather than
   * something the trigger could know.
   *
   * Without resolving them, `affectedRange` had nothing to work from and every commit finished as
   * `nothing_to_do`: the job succeeded, wrote no snapshots, and Home stayed on its empty state
   * (ADR-058.6).
   */
  const triggerRefId = typeof payload.triggerRefId === 'string' ? payload.triggerRefId
    : typeof payload.trigger_ref === 'string' ? payload.trigger_ref
    : null;

  const changedPeriodIds = Array.isArray(payload.period_ids)
    ? (payload.period_ids as unknown[]).filter((id): id is string => typeof id === 'string')
    : await periodsTouchedBy(scoped, orgId, triggerRefId);

  /*
   * "Today" in the organisation's timezone, resolved once and passed in (ADR-030.5). The engine
   * never reads a clock; aging and runway are functions of this value, so a run replayed with the
   * same `asOf` reproduces the same figures.
   */
  const asOf = typeof payload.as_of === 'string'
    ? payload.as_of
    : await organisationToday(scoped, orgId);

  const outcome = await runCalculation({
    scoped,
    computePeriod: (input) => {
      const aggregates = input.aggregates as {
        aggregates: readonly AggregateCell[];
        transferLegs: readonly { periodId: string; bankAccountId: string; transferKind: string; inflow: string; outflow: string }[];
        coverage: PeriodCoverage;
      };
      return composePeriod({
        period: input.period as PeriodRef,
        coverage: aggregates.coverage,
        cells: aggregates.aggregates,
        transferLegs: aggregates.transferLegs,
        context: input.context as EngineContext,
      });
    },
    startRun: startCalculationRun,
    finishChunk,
    finishRun: (runId, status, stats, error) =>
      finishCalculationRun(runId, orgId, status, stats, error),
    setCompleteness: (periods, complete) => setPeriodCompleteness(orgId, periods, complete),
    // The health step reads the snapshots this chunk just committed (§7.4 pins their ids), so it
    // takes the same scoped client and nothing else.
    scoreHealth: healthStep({ scoped, finishHealth }),
  }, {
    organizationId: orgId,
    trigger,
    triggerRefId,
    asOf,
    jobId: job.jobId,
    changedPeriodIds,
  });

  /*
   * §8.1: alerts are evaluated after every SUCCESSFUL run, as a separate job.
   *
   * Separate rather than inline, for two reasons the queue already solves: the alert pass reads the
   * snapshots this run committed, so it must not share the run's transaction; and if it fails it
   * must retry without re-running the calculation, which is far more expensive.
   */
  if (outcome.status === 'succeeded' && outcome.runId !== null) {
    /*
     * A NULL actor, always.
     *
     * `api_server.enqueue_job` documents it — "system job types carry a null actor" — and the
     * `jobs.requested_by` foreign key enforces it: a placeholder uuid is not a profile, so a
     * synthetic system id fails the constraint. Passing the person who triggered the CALCULATION
     * would also be wrong: they did not ask for the alert pass, and attributing machine work to a
     * human is how an audit trail stops meaning anything.
     */
    await enqueueServerJob(
      null,
      {
        organizationId: orgId,
        jobType: 'alerts.evaluate',
        payload: { run_id: outcome.runId },
      },
    ).catch((cause: unknown) => {
      // The figures are committed and correct; only the alert pass is missing. Failing the whole
      // run here would roll nothing back and would hide a good calculation behind a queue problem.
      return { deferred: cause instanceof Error ? cause.message : String(cause) };
    });
  }

  return {
    status: outcome.status === 'failed' ? 'failed' : 'succeeded',
    result: {
      run_id: outcome.runId,
      run_status: outcome.status,
      periods: outcome.periodsWritten,
      snapshots: outcome.snapshotsWritten,
      health_scores: outcome.healthScoresWritten,
    },
  };
}

/**
 * Today, in the organisation's own timezone.
 *
 * A UK business closing March on the 1st of April at 00:30 must not have its March run dated the
 * 31st; a business in Dubai must not have it dated the 2nd. The zone is a setting, so it is read
 * rather than assumed.
 */
async function organisationToday(db: SupabaseClient, orgId: string): Promise<string> {
  const { data } = await db
    .from('organizations')
    .select('timezone')
    .eq('id', orgId)
    .maybeSingle();

  const timezone = (data as { timezone?: string } | null)?.timezone ?? 'UTC';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * The fiscal periods a batch's declared range covers.
 *
 * The batch declares what it covers (§2.2) rather than having it inferred from its rows, so this is
 * the honest answer to "what changed": a statement covering March changes March, even if its last
 * transaction is on the 20th.
 *
 * An empty result would leave the run with nothing to do, so a batch that cannot be resolved falls
 * back to every period the organisation has — a wider recompute is wasteful, and silently computing
 * nothing after somebody imported a file is not.
 */
async function periodsTouchedBy(
  db: SupabaseClient, orgId: string, batchId: string | null,
): Promise<string[]> {
  if (batchId !== null) {
    const { data: batch } = await db
      .from('import_batches')
      .select('period_start, period_end')
      .eq('organization_id', orgId)
      .eq('id', batchId)
      .maybeSingle();

    const range = batch as { period_start?: string; period_end?: string } | null;
    if (range?.period_start != null && range.period_end != null) {
      const { data } = await db
        .from('fiscal_periods')
        .select('id')
        .eq('organization_id', orgId)
        .lte('period_start', range.period_end)
        .gte('period_end', range.period_start);
      const ids = ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
      if (ids.length > 0) return ids;
    }
  }

  const { data } = await db
    .from('fiscal_periods')
    .select('id')
    .eq('organization_id', orgId);
  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
}
