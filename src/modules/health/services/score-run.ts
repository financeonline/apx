import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { log } from '@/core/logging';
import type { AccountObservation, RuleContext } from '@/modules/alerts';
import { computeHealthScore } from '../domain/score';
import type { HealthInput, HealthScore } from '../domain/types';
import * as repo from '../data/repository';

/**
 * Scoring the periods of one calculation chunk (FINANCIAL_ENGINE.md §7, §2.4).
 *
 * This runs AFTER the chunk's snapshots are committed, not before, for one reason: §7.4 requires the
 * breakdown to pin the snapshot behind every metric a dimension rested on, and an in-flight
 * `MetricResult` has no id yet. Scoring from the committed rows costs one read per chunk and buys an
 * explainability panel whose links actually resolve — the difference between "net margin 8.3%" and
 * "net margin 8.3%, and here is the figure it came from".
 *
 * It also means the score reads the same lookback the rest of the run does, including periods
 * written by earlier chunks of this same run, because chunks commit oldest first.
 */

export interface HealthChunkRequest {
  readonly organizationId: string;
  readonly calculationRunId: string;
  /** The periods of this chunk, oldest first. */
  readonly chunkPeriodIds: readonly string[];
  /** The chunk plus its lookback, oldest first — the series the trailing rules walk. */
  readonly windowPeriodIds: readonly string[];
  /** The instant this chunk aggregated at; the condition rules read as of it (§2.4). */
  readonly aggregatedAt: string;
  readonly currency: string;
  /** `is_complete` per period id, as the run computed it. */
  readonly completeness: ReadonlyMap<string, boolean>;
  /** Bank coverage ratio per period id, as the run computed it (§2.2). */
  readonly bankCoverage: ReadonlyMap<string, number>;
  /** The organisation's earliest period that has any data, for the first-period gate (§8.1). */
  readonly firstPeriodWithDataId: string | null;
  /** The chart of accounts and counterparty names the rules render sentences from (§8.2). */
  readonly accounts: readonly AccountObservation[];
  readonly counterpartyNames: ReadonlyMap<string, string>;
  /** The last day of each period, for the rules that test "overdue" against a period end. */
  readonly periodEnds: ReadonlyMap<string, string>;
}

export interface HealthRunDeps {
  readonly scoped: SupabaseClient;
  /** `api_server.finish_health`, injected so the lint boundary holds and the loop stays testable. */
  readonly finishHealth: (input: Record<string, unknown>) => Promise<{ written: number }>;
}

/**
 * The counterparties first seen in `periodId`, within the loaded window.
 *
 * "New" is relative to the twelve months the run loaded, which is what the unusual-transaction rule
 * needs and all it can honestly claim. Calling a supplier "new" because their last invoice was
 * fourteen months ago would be wrong; the alternative — an unbounded history scan per period — costs
 * more than the rule is worth. Stated here rather than left implicit.
 */
export function newCounterpartyIdsIn(
  records: readonly repo.RecordObservationLike[],
  periodId: string,
  windowPeriodIds: readonly string[],
): string[] {
  const index = windowPeriodIds.indexOf(periodId);
  if (index < 0) return [];
  const earlier = new Set(windowPeriodIds.slice(0, index));

  const seenEarlier = new Set<string>();
  const seenNow = new Set<string>();
  for (const record of records) {
    if (record.counterpartyId === null) continue;
    if (earlier.has(record.periodId)) seenEarlier.add(record.counterpartyId);
    else if (record.periodId === periodId) seenNow.add(record.counterpartyId);
  }
  return [...seenNow].filter((id) => !seenEarlier.has(id)).sort();
}

/**
 * Score every COMPLETE period of a chunk and write the results.
 *
 * Incomplete periods are skipped and no row is written for them (ADR-030.4). Home shows the latest
 * complete month's score and "{Month} so far" without one.
 */
export async function scoreChunk(
  deps: HealthRunDeps,
  request: HealthChunkRequest,
): Promise<{ written: number; scores: readonly HealthScore[] }> {
  const { scoped, finishHealth } = deps;
  const orgId = request.organizationId;

  const scoreable = request.chunkPeriodIds.filter(
    (periodId) => request.completeness.get(periodId) === true,
  );
  if (scoreable.length === 0) return { written: 0, scores: [] };

  const [snapshots, records, recurringGroups] = await Promise.all([
    repo.loadObservations(scoped, orgId, request.windowPeriodIds),
    repo.loadBankRecords(scoped, orgId, request.windowPeriodIds, request.aggregatedAt),
    repo.loadRecurringGroups(scoped, orgId),
  ]);

  const scores: HealthScore[] = [];

  for (const periodId of scoreable) {
    const trailingComplete = request.windowPeriodIds
      .slice(0, request.windowPeriodIds.indexOf(periodId))
      .filter((id) => request.completeness.get(id) === true)
      .slice(-6);

    const conditions: RuleContext = {
      organizationId: orgId,
      calculationRunId: request.calculationRunId,
      aggregatedAt: request.aggregatedAt,
      periodId,
      periodEnd: request.periodEnds.get(periodId) ?? '',
      isComplete: true,
      isFirstPeriodWithData: request.firstPeriodWithDataId === periodId,
      snapshots,
      records: records.filter((r) => r.periodId === periodId),
      trailingRecords: records.filter((r) => trailingComplete.includes(r.periodId)),
      recurringGroups,
      trailingCompletePeriodIds: trailingComplete,
      newCounterpartyIds: newCounterpartyIdsIn(records, periodId, request.windowPeriodIds),
      accounts: request.accounts,
      counterpartyNames: request.counterpartyNames,
    };

    const input: HealthInput = {
      organizationId: orgId,
      periodId,
      periodIds: request.windowPeriodIds,
      isComplete: true,
      currency: request.currency,
      snapshots,
      bankCoverageRatio: request.bankCoverage.get(periodId) ?? 0,
      conditions,
    };

    const score = computeHealthScore(input);
    if (score !== null) scores.push(score);
  }

  if (scores.length === 0) return { written: 0, scores: [] };

  const result = await finishHealth({
    p_org: orgId,
    p_run: request.calculationRunId,
    p_scores: scores.map((score) => ({
      period_id: score.periodId,
      score: score.score,
      dimensions_used: score.dimensionsUsed,
      dimensions_total: score.dimensionsTotal,
      breakdown: score.breakdown,
      config_version: score.configVersion,
    })),
    p_period_ids: scores.map((score) => score.periodId),
  });

  log.info('health scores written', {
    organizationId: orgId,
    runId: request.calculationRunId,
    periods: scores.length,
  });

  return { written: result.written, scores };
}

/**
 * The health step as the calculation run wants it: one function of a chunk.
 *
 * The run holds `scoreHealth` as an injected dependency so the engine never imports the health
 * rules; this is the adapter that satisfies it, so wiring the worker is one line rather than a
 * second copy of the request mapping.
 */
export function healthStep(
  deps: HealthRunDeps,
): (request: HealthChunkRequest) => Promise<{ written: number }> {
  return async (request) => {
    const { written } = await scoreChunk(deps, request);
    return { written };
  };
}
