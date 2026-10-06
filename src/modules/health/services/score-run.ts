import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { log } from '@/core/logging';
import type { AccountObservation, MetricObservation, RuleContext } from '@/modules/alerts';
import { calculationRunLabel, metricSnapshotLabel } from '@/modules/evidence';
import { ENGINE_VERSION } from '@/modules/financial-engine';
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
  /** Bank evidence ratio per period id, as the run computed it (§2.2); NULL = no bank data (H-1). */
  readonly bankCoverage: ReadonlyMap<string, number | null>;
  /** The organisation's earliest period that has any data, for the first-period gate (§8.1). */
  readonly firstPeriodWithDataId: string | null;
  /** The chart of accounts and counterparty names the rules render sentences from (§8.2). */
  readonly accounts: readonly AccountObservation[];
  readonly counterpartyNames: ReadonlyMap<string, string>;
  /** The last day of each period, for the rules that test "overdue" against a period end. */
  readonly periodEnds: ReadonlyMap<string, string>;
  /** The first day of each period in the window (health.config.v5: marketing's window). */
  readonly periodStarts?: ReadonlyMap<string, string>;
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

  // health.config.v5 (ADR-147): invoices issued by the last scored month's end, and the Commercial
  // records, for the two dimensions that read them.
  const lastEnd = scoreable.map((p) => request.periodEnds.get(p) ?? '').sort().at(-1) ?? '';
  const [snapshots, records, recurringGroups, invoices, commercial] = await Promise.all([
    repo.loadObservations(scoped, orgId, request.windowPeriodIds),
    repo.loadBankRecords(scoped, orgId, request.windowPeriodIds, request.aggregatedAt),
    repo.loadRecurringGroups(scoped, orgId),
    repo.loadInvoicesForHealth(scoped, orgId, lastEnd),
    repo.loadCommercialForHealth(scoped, orgId, request.windowPeriodIds),
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
      bankCoverageRatio: request.bankCoverage.get(periodId) ?? null,
      conditions,
      periodEnds: request.periodEnds,
      ...(request.periodStarts === undefined ? {} : { periodStarts: request.periodStarts }),
      invoices,
      commercial,
    };

    const score = computeHealthScore(input);
    if (score !== null) scores.push(score);
  }

  if (scores.length === 0) return { written: 0, scores: [] };

  // Only for the labels (§2.2): an item is named from the object it points at, and a period is part
  // of that name.
  const periodLabels = await repo.loadPeriodLabels(
    scoped, orgId, scores.map((score) => score.periodId),
  );

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
      evidence: evidenceFor(
        score, snapshots, periodLabels.get(score.periodId) ?? null, request.calculationRunId,
      ),
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
 * The evidence a health score rests on (EVIDENCE_MODEL.md §5, health-dimension row).
 *
 * §7.4 already pins the exact `metric_snapshots.id` behind every figure a dimension used, so the
 * bundle is a matter of naming them rather than of finding them. The run comes first — it is the
 * "as of" context every item is read under — then one item per distinct snapshot, in the order the
 * dimensions used them, so a reader works down the score the way it was built.
 *
 * A snapshot with no id is skipped rather than cited as null: `snapshotId` is null only while a
 * figure is still in flight inside the chunk that computed it, and an item pointing at nothing is
 * an item nobody can open.
 */
function evidenceFor(
  score: HealthScore,
  observations: readonly MetricObservation[],
  periodLabel: string | null,
  calculationRunId: string,
): Array<Record<string, unknown>> {
  const byId = new Map(
    observations.filter((o) => o.snapshotId !== null).map((o) => [o.snapshotId!, o]),
  );

  const items: Array<Record<string, unknown>> = [{
    item_type: 'calculation_run',
    ref_id: calculationRunId,
    label: calculationRunLabel({ engineVersion: ENGINE_VERSION, finishedAt: null }),
    assurance_level: 'verified',
  }];

  const seen = new Set<string>();
  for (const dimension of score.breakdown) {
    for (const metric of dimension.metrics) {
      const id = metric.snapshot_id;
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      const observation = byId.get(id);
      items.push({
        item_type: 'metric_snapshot',
        ref_id: id,
        label: metricSnapshotLabel({
          metricKey: metric.metric_key,
          periodLabel,
          basis: observation?.basis ?? 'none',
        }),
        assurance_level: observation?.assurance ?? 'calculated',
      });
    }
  }
  return items;
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
