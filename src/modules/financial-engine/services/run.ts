import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import { bankingRuleVersions } from '@/modules/banking';
import { log } from '@/core/logging';
import { affectedRange, chunkPeriods, chunkWindow, type CalculationTrigger } from '../domain/chunking';
import { computeCoverage, isPeriodComplete } from '../domain/coverage';
import { computeFingerprint } from '../domain/fingerprint';
import { AS_OF_DEPENDENT_KEYS } from '../domain/registry';
import { VARIANCE_BASE_METRICS } from '../domain/variance';
import { comparisonPeriodIds, variancesForPeriod } from '../domain/variance-pass';
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
 *      organization's timezone and enters the fingerprint only when the current period is in range,
 *      and the instant the run aggregates as of comes from the database row, not from `new Date()` —
 *      the aggregate compares it against database-stamped `created_at`, so a second clock in that
 *      comparison decides which rows a run can see.
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
  readonly healthScoresWritten: number;
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
    // Null when the computer did not mint one; `finish_chunk` then falls back to gen_random_uuid().
    id: result.id ?? null,
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
  /**
   * The instant this chunk aggregates as of, read from the DATABASE (§2.4 step 4).
   *
   * Injected like every other `api_server` call, so the loop stays testable and the lint boundary
   * holds — and so a test can pin the instant instead of racing a clock.
   */
  readonly aggregationInstant: () => Promise<string>;
  readonly finishChunk: (input: Record<string, unknown>) => Promise<{ written: number }>;
  readonly finishRun: (
    runId: string, status: 'succeeded' | 'failed', stats: Record<string, unknown>, error?: unknown,
  ) => Promise<void>;
  readonly setCompleteness: (periods: string[], complete: boolean[]) => Promise<void>;
  /**
   * Scores the complete periods of a chunk (FINANCIAL_ENGINE.md §7).
   *
   * Injected rather than imported so this loop stays unaware of the health rules, and so the health
   * module can depend on the engine without the engine depending back. It is called AFTER the
   * chunk commits, because §7.4 pins the snapshot behind every metric a dimension rested on and an
   * uncommitted snapshot has no id.
   */
  readonly scoreHealth: (input: HealthChunkInput) => Promise<{ written: number }>;
  /**
   * The banking pass (Phase 13, ADR-101; §2.4 step 5): rule categorisation, transfer pairing and
   * recurring detection over the organisation's accepted rows, applied BEFORE the fingerprint is
   * read so that what it wrote is part of what the fingerprint sees. A run over an unchanged
   * organisation therefore still finishes `no_change`; a run whose rows changed re-categorises
   * first and then computes from the result. Optional so the loop's own tests need not supply it.
   */
  readonly bankingPass?: (input: { organizationId: string; asOf: string }) => Promise<unknown>;
}

/** What the health step needs from the chunk that just committed. */
export interface HealthChunkInput {
  readonly organizationId: string;
  readonly calculationRunId: string;
  readonly chunkPeriodIds: readonly string[];
  readonly windowPeriodIds: readonly string[];
  readonly aggregatedAt: string;
  readonly currency: string;
  readonly completeness: ReadonlyMap<string, boolean>;
  readonly bankCoverage: ReadonlyMap<string, number>;
  readonly firstPeriodWithDataId: string | null;
  readonly periodEnds: ReadonlyMap<string, string>;
  readonly accounts: ReadonlyArray<{ id: string; name: string; standardCategory: string }>;
  readonly counterpartyNames: ReadonlyMap<string, string>;
}

export async function runCalculation(
  deps: RunDeps,
  request: RunRequest,
): Promise<RunOutcome> {
  const { scoped } = deps;
  const orgId = request.organizationId;
  if (deps.bankingPass) await deps.bankingPass({ organizationId: orgId, asOf: request.asOf });

  const [allPeriods, accounts, counterparties, bankAccounts, settings, fingerprintSources] =
    await Promise.all([
      repo.loadPeriods(scoped, orgId),
      repo.loadAccounts(scoped, orgId),
      repo.loadCounterparties(scoped, orgId),
      repo.loadBankAccounts(scoped, orgId),
      repo.loadSettings(scoped, orgId),
      repo.loadFingerprintSources(scoped, orgId),
    ]);

  // The first-period gate (§8.1) needs this once per run, not once per chunk.
  const firstPeriodWithDataId = await repo.loadFirstPeriodWithData(scoped, orgId, allPeriods);

  // §3.1's "never used" is a fact about the ORGANISATION, so it is resolved once here rather than
  // re-derived per period from that period's rows (ADR-063).
  const costOfSalesEverUsed = await repo.loadCostOfSalesEverUsed(scoped, orgId);

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
    return {
      runId: null, status: 'nothing_to_do',
      periodsWritten: 0, snapshotsWritten: 0, healthScoresWritten: 0,
    };
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
    // The keyword set, the recurring detector and their composition (Phase 13, ADR-101): a change
    // to any of them re-categorises history, so it must re-fingerprint too.
    detectorVersion: bankingRuleVersions(),
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
    return {
      runId: started.runId, status: 'no_change',
      periodsWritten: 0, snapshotsWritten: 0, healthScoresWritten: 0,
    };
  }

  const runId = started.runId;

  let snapshotsWritten = 0;
  let periodsWritten = 0;
  let healthScoresWritten = 0;

  try {
    /** ADR-080: every period this run has computed, levels and variances, for later chunks to compare against. */
    const computedThisRun = new Map<string, readonly MetricResult[]>();
    for (const chunk of chunkPeriods(toWrite)) {
      /*
       * Each chunk pins its own instant, and reads it from the DATABASE (§2.4 step 4:
       * `aggregated_at = transaction_timestamp()`).
       *
       * The clock matters because `app.aggregate_periods` filters `created_at <= aggregated_at` and
       * `created_at` is stamped by Postgres. Pinning it with the worker's `new Date()` compared two
       * clocks: whenever the database's ran ahead — it does, by tens of milliseconds, on any host
       * running Postgres in a container — rows committed BEFORE the run was queued fell the wrong
       * side of the cutoff and the run computed without them, silently, reporting the shortfall as a
       * figure (ADR-063).
       *
       * PER CHUNK, not per run, because ADR-047.7 says so and EVIDENCE_MODEL.md §11 tests it: a run
       * whose middle chunk aggregates after a supersession must resolve chunk-1 descriptors to the
       * pre-supersession rows and chunk-2's to the post-supersession rows, each reconciling to its
       * own snapshot. One instant for the whole run would make that case unrepresentable.
       */
      const aggregatedAt = await deps.aggregationInstant();
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
        costOfSalesEverUsed,
        counterparties,
        bankAccounts,
        periods: window,
        aggregates,
        transferLegs,
        batches,
      };

      const snapshots: Record<string, unknown>[] = [];
      /*
       * §3.2, ADR-080: the comparison figures this chunk's variances read. A period this run already
       * computed is compared in memory; any other comparison period comes from what the last run
       * left in `metric_current`. Loaded once per chunk, for every period the chunk will ask about.
       */
      const wanted = new Set(chunk.flatMap((p) => comparisonPeriodIds(p, allPeriods)).filter((id) => !computedThisRun.has(id)));
      const storedComparisons = range.asOfDependentOnly ? [] : await repo.loadCurrentObservations(
        scoped, orgId, [...wanted].filter((id) => !chunk.some((p) => p.id === id)), VARIANCE_BASE_METRICS,
      );
      const completePeriods: string[] = [];
      const completeFlags: boolean[] = [];
      const bankCoverage = new Map<string, number>();

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

        // ADR-047.8: an as-of-only run rewrites aging and runway and leaves every comparison as it was.
        const variances = range.asOfDependentOnly ? [] : variancesForPeriod({
          period, allPeriods, results, computed: computedThisRun, stored: storedComparisons,
          currency: settings.baseCurrency ?? null, mint: randomUUID,
        });
        computedThisRun.set(period.id, [...results, ...variances]);
        for (const result of [...results, ...variances]) snapshots.push(serialiseSnapshot(period.id, result));

        completePeriods.push(period.id);
        completeFlags.push(isPeriodComplete(coverage, period, bankAccounts));
        bankCoverage.set(period.id, coverage.bankCoverageRatio);
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

      /*
       * The health score, last, and only for the periods this chunk just proved complete.
       *
       * `setCompleteness` runs first because `api_server.finish_health` refuses a score for a period
       * whose `is_complete` is not true (ADR-030.4) — the flag has to be on the row before the score
       * is offered against it. A scheduled as-of-only run is skipped: it rewrites aging and runway
       * for the current, partial period, which is never scored anyway (ADR-047.8).
       */
      if (!range.asOfDependentOnly) {
        /*
         * Completeness for the WHOLE window, not just this chunk: the trailing rules (C3, G2, B1)
         * and the "trailing complete months" thresholds walk backwards past the chunk boundary, and
         * a lookback period missing from this map would be read as incomplete and silently dropped
         * from a three-month trend.
         */
        const completeness = new Map<string, boolean>(
          window.map((p) => [p.id, p.isComplete]),
        );
        completePeriods.forEach((periodId, index) => {
          completeness.set(periodId, completeFlags[index] === true);
        });
        const health = await deps.scoreHealth({
          organizationId: orgId,
          calculationRunId: runId,
          chunkPeriodIds: chunk.map((p) => p.id),
          windowPeriodIds: window.map((p) => p.id),
          aggregatedAt,
          currency: settings.baseCurrency,
          completeness,
          bankCoverage,
          firstPeriodWithDataId,
          periodEnds: new Map(window.map((p) => [p.id, p.periodEnd])),
          accounts: accounts.map((a) => ({
            id: a.id, name: a.name, standardCategory: a.standardCategory,
          })),
          counterpartyNames: new Map(counterparties.map((c) => [c.id, c.name])),
        });
        healthScoresWritten += health.written;
      }
    }

    await deps.finishRun(runId, 'succeeded', {
      periods: periodsWritten, snapshots: snapshotsWritten, health_scores: healthScoresWritten,
    });

    return { runId, status: 'succeeded', periodsWritten, snapshotsWritten, healthScoresWritten };
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
