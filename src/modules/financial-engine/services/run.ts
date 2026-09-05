import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import { log } from '@/core/logging';
import { affectedRange, chunkPeriods, chunkWindow, type CalculationTrigger } from '../domain/chunking';
import { computeCoverage, isPeriodComplete } from '../domain/coverage';
import { computeFingerprint } from '../domain/fingerprint';
import { AS_OF_DEPENDENT_KEYS } from '../domain/registry';
import { ENGINE_VERSION as VERSION } from '../domain/version';
import type { MetricResult, PeriodRef } from '../domain/types';
import * as repo from '../data/repository';

/**
 * The calculation run (FINANCIAL_ENGINE.md §2.4).
 *
 * A run is a chain of chunks of at most twelve consecutive months, oldest first. Oldest first is not
 * a preference: cross-period inputs — opening cash, trailing averages, year-on-year comparisons —
 * read the previous period's pointers, which this run wrote in the previous chunk.
 *
 * Three properties this file exists to guarantee:
 *
 *   1. **Idempotence.** The fingerprint is computed from aggregate metadata BEFORE any write. An
 *      equal fingerprint finishes the run immediately, so a nightly job over unchanged data does not
 *      rewrite a year of identical snapshots.
 *
 *   2. **Atomic visibility.** Snapshots and pointers move in one transaction per chunk, so a reader
 *      never sees a half-written period, and a failed run puts back exactly the pointers it
 *      replaced rather than leaving a range mixed between two runs.
 *
 *   3. **Determinism.** Nothing here reads a clock. `asOf` is supplied by the caller from the
 *      organization's timezone and enters the fingerprint only when the current period is in range.
 */

export interface RunRequest {
  readonly organizationId: string;
  readonly trigger: CalculationTrigger;
  readonly triggerRefId: string | null;
  /** Today in the organization's timezone (ADR-030.5). Never `new Date()` inside this module. */
  readonly asOf: string;
  readonly jobId: string | null;
  /** Periods whose records changed since the last succeeded run. */
  readonly changedPeriodIds: readonly string[];
}

export interface RunOutcome {
  readonly runId: string | null;
  readonly status: 'succeeded' | 'no_change' | 'nothing_to_do' | 'failed';
  readonly periodsWritten: number;
  readonly snapshotsWritten: number;
}

/**
 * Computes one period's metrics.
 *
 * Injected rather than imported so the run loop can be tested against a stub, and so the pure metric
 * modules stay unaware that a database exists. The real implementation composes the P&L, cash,
 * receivables and concentration modules in registry order.
 */
export type PeriodComputer = (input: {
  readonly period: PeriodRef;
  readonly aggregates: readonly repo.TransferLeg[] | unknown;
  readonly context: unknown;
}) => Promise<readonly MetricResult[]> | readonly MetricResult[];

function serialiseSnapshot(periodId: string, result: MetricResult): Record<string, unknown> {
  return {
    period_id: periodId,
    metric_key: result.key,
    dimension_type: result.dimensionType,
    dimension_id: result.dimensionId,
    dimension_key: result.dimensionKey ?? null,
    value: result.value,
    unit: result.unit,
    currency: result.currency,
    basis: result.basis,
    assurance_level: result.assurance,
    data_quality: result.dataQuality,
    components: result.components,
    evidence_query: result.evidenceQuery,
  };
}

export interface RunDeps {
  readonly scoped: SupabaseClient;
  readonly computePeriod: PeriodComputer;
  /** `api_server` calls, injected so the lint boundary holds and the loop stays testable. */
  readonly startRun: (input: Record<string, unknown>) => Promise<{ runId: string; noChange: boolean }>;
  readonly finishChunk: (input: Record<string, unknown>) => Promise<{ written: number }>;
  readonly finishRun: (
    runId: string, status: 'succeeded' | 'failed', stats: Record<string, unknown>, error?: unknown,
  ) => Promise<void>;
  readonly setCompleteness: (periods: string[], complete: boolean[]) => Promise<void>;
}

export async function runCalculation(
  deps: RunDeps,
  request: RunRequest,
): Promise<RunOutcome> {
  const { scoped } = deps;
  const orgId = request.organizationId;

  const [allPeriods, accounts, counterparties, bankAccounts, settings, fingerprintSources] =
    await Promise.all([
      repo.loadPeriods(scoped, orgId),
      repo.loadAccounts(scoped, orgId),
      repo.loadCounterparties(scoped, orgId),
      repo.loadBankAccounts(scoped, orgId),
      repo.loadSettings(scoped, orgId),
      repo.loadFingerprintSources(scoped, orgId),
    ]);

  const currentPeriod = allPeriods.find(
    (p) => p.periodStart <= request.asOf && p.periodEnd >= request.asOf,
  );

  const range = affectedRange({
    trigger: request.trigger,
    changedPeriodIds: request.changedPeriodIds,
    allPeriods,
    currentPeriodId: currentPeriod?.id ?? null,
  });

  if (!range.affectedFrom || !range.to) {
    return { runId: null, status: 'nothing_to_do', periodsWritten: 0, snapshotsWritten: 0 };
  }

  const affectedIndex = allPeriods.findIndex((p) => p.id === range.affectedFrom);
  const toIndex = allPeriods.findIndex((p) => p.id === range.to);
  const toWrite = allPeriods.slice(affectedIndex, toIndex + 1);

  // ADR-047.8: today enters the fingerprint ONLY when the range reaches the current period.
  // Including it always would make every nightly run look different and idempotence would never
  // fire; never including it would freeze aging and runway.
  const rangeIncludesCurrent = currentPeriod !== undefined
    && toWrite.some((p) => p.id === currentPeriod.id);

  const fingerprint = computeFingerprint({
    organizationId: orgId,
    engineVersion: VERSION,
    periodFrom: range.affectedFrom,
    periodTo: range.to,
    maxRecordEventAt: fingerprintSources.maxRecordEventAt,
    rowCounts: fingerprintSources.rowCounts,
    accountCategories: fingerprintSources.accountCategories,
    categoryHistoryHeads: fingerprintSources.categoryHistoryHeads,
    counterpartyMerges: fingerprintSources.counterpartyMerges,
    settings: {
      baseCurrency: settings.baseCurrency,
      fiscalYearStartMonth: settings.fiscalYearStartMonth,
      vatRegistered: settings.vatRegistered,
      defaultVatRate: settings.defaultVatRate,
      taxableCategories: [...settings.taxableCategories],
    },
    detectorVersion: 'recurring.v1',
    asOfDate: rangeIncludesCurrent ? request.asOf : null,
  });

  const started = await deps.startRun({
    p_org: orgId,
    p_trigger: request.trigger,
    p_trigger_ref: request.triggerRefId,
    p_engine_version: VERSION,
    p_period_from: range.affectedFrom,
    p_period_to: range.to,
    p_as_of: request.asOf,
    p_fingerprint: fingerprint,
    p_job: request.jobId,
    p_periods_total: toWrite.length,
  });

  if (started.noChange) {
    // Nothing the engine reads has changed. The existing pointers stand.
    return { runId: started.runId, status: 'no_change', periodsWritten: 0, snapshotsWritten: 0 };
  }

  const runId = started.runId;
  let snapshotsWritten = 0;
  let periodsWritten = 0;

  try {
    for (const chunk of chunkPeriods(toWrite)) {
      // Each chunk pins its own instant. The descriptors of this chunk's snapshots carry it, so the
      // evidence resolver can reproduce exactly this selection later (ADR-046.2, ADR-047.7).
      const aggregatedAt = new Date().toISOString();
      const window = chunkWindow(allPeriods, chunk);
      const windowFrom = window[0]?.periodStart ?? chunk[0]!.periodStart;
      const windowTo = chunk[chunk.length - 1]!.periodEnd;

      const [aggregates, transferLegs, batches] = await Promise.all([
        repo.loadAggregates(scoped, orgId, windowFrom, windowTo, aggregatedAt),
        repo.loadTransferLegs(scoped, orgId, windowFrom, windowTo, aggregatedAt),
        repo.loadCoverageBatches(scoped, orgId, windowFrom, windowTo),
      ]);

      const context = {
        organizationId: orgId,
        calculationRunId: runId,
        aggregatedAt,
        asOf: request.asOf,
        engineVersion: VERSION,
        settings,
        accounts,
        counterparties,
        bankAccounts,
        periods: window,
        aggregates,
        transferLegs,
        batches,
      };

      const snapshots: Record<string, unknown>[] = [];
      const completePeriods: string[] = [];
      const completeFlags: boolean[] = [];

      for (const period of chunk) {
        const rowCounts: Record<string, number> = {};
        for (const cell of aggregates) {
          if (cell.periodId !== period.id) continue;
          const key = cell.source === 'period_balances' ? 'period_balances'
            : cell.source === 'ledger' ? 'ledger'
            : cell.source === 'invoices' ? 'invoices' : 'bank';
          rowCounts[key] = (rowCounts[key] ?? 0) + cell.rowCount;
        }

        const coverage = computeCoverage({
          period, batches, bankAccounts, rowCounts, asOf: request.asOf,
        });

        const results = await deps.computePeriod({
          period,
          aggregates: { aggregates, transferLegs, coverage },
          context,
        });

        for (const result of results) snapshots.push(serialiseSnapshot(period.id, result));

        completePeriods.push(period.id);
        completeFlags.push(isPeriodComplete(coverage, period, bankAccounts));
      }

      const written = await deps.finishChunk({
        p_org: orgId,
        p_run: runId,
        p_snapshots: snapshots,
        p_period_ids: chunk.map((p) => p.id),
        p_aggregated_at: aggregatedAt,
        p_cursor: chunk[0]!.id,
        // ADR-047.8: a scheduled run rewrites only the as-of-dependent keys, leaving every other
        // figure exactly as the last full run left it.
        p_as_of_keys: range.asOfDependentOnly ? [...AS_OF_DEPENDENT_KEYS] : null,
      });

      snapshotsWritten += written.written;
      periodsWritten += chunk.length;

      await deps.setCompleteness(completePeriods, completeFlags);
    }

    await deps.finishRun(runId, 'succeeded', {
      periods: periodsWritten, snapshots: snapshotsWritten,
    });

    return { runId, status: 'succeeded', periodsWritten, snapshotsWritten };
  } catch (cause) {
    // §2.4 step 12: mark the run failed and restore every pointer it replaced. Leaving a range mixed
    // between two runs is the one outcome that must never happen — a reader would see this month
    // from a failed run and last month from the previous one.
    log.error('a calculation run failed', {
      organizationId: orgId, runId,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    await deps.finishRun(runId, 'failed', { periods: periodsWritten }, {
      message: cause instanceof Error ? cause.message : String(cause),
    }).catch(() => {
      // The run could not even be marked failed; the original error is the one worth raising.
    });
    throw toMotionError(cause);
  }
}
