import 'server-only';
import { finishForecast } from '@/core/db';
import { assertCan } from '@/core/permissions';
import { NotFound } from '@/core/errors';
import { Decimal, parseDecimalOrNull, toMoneyString } from '@/core/money';
import type { AccessContext } from '@/modules/tenancy';
import { HORIZON_MONTHS } from '../domain/config';
import { FORECAST_LEAVES, composeForecast } from '../domain/compose';
import type { ActualPoint, ForecastResult } from '../domain/types';
import * as repo from '../data/repository';

/**
 * The forecast service (REQ-FC-01/02; ADR-099).
 *
 * **The engine is authoritative and this module reads it.** Every number a forecast rests on is a
 * `metric_snapshots` figure the deterministic engine wrote; nothing here computes a metric. What it
 * computes is a statement ABOUT those figures — a recency-weighted level and the identities between
 * them — which is a different kind of claim and is stored in different tables so the two can never
 * be confused (`DATABASE_ARCHITECTURE.md`, `forecast_runs`).
 *
 * **Generated on demand, stored once, and known to be stale.** A forecast is written when somebody
 * asks for one, like an evidence bundle (ADR-066), rather than on every calculation run — most
 * organisations never open the page, and a forecast nobody read is a row nobody needed. Every run
 * records the `calculation_run_id` its baselines read, so "the figures have changed since this was
 * worked out" is a fact the product can state instead of a risk it carries (§20, §23).
 */

export interface ForecastMetricView {
  readonly metricKey: string;
  /** NUMERIC as a string (ADR-006). */
  readonly value: string;
  readonly currency: string | null;
  readonly derivation: 'baseline' | 'identity';
  readonly derivedFrom: readonly string[];
  /** The most recent ACTUAL for the same metric, for the actual-versus-forecast line (§14). */
  readonly lastActual: { readonly value: string; readonly periodLabel: string } | null;
  /** forecast − last actual. `null` when there is no actual to compare with. */
  readonly change: string | null;
}

export interface ForecastPeriodView {
  readonly periodId: string;
  readonly periodLabel: string;
  /**
   * The first day of the month, which is what the ordering is actually by.
   *
   * Carried on the view from Phase 12 (ADR-100) because the scenario engine composes over the same
   * horizon and needs the real period rows; without it a second reader would have to query
   * `fiscal_periods` again for something this loader already has in hand.
   */
  readonly periodStart: string;
  readonly metrics: readonly ForecastMetricView[];
}

export interface ForecastView {
  readonly runId: string;
  readonly method: string;
  readonly configVersion: string;
  readonly generatedAt: string;
  readonly periodsUsed: number;
  readonly basis: 'strong' | 'limited' | 'weak' | null;
  readonly periods: readonly ForecastPeriodView[];
  /** Every metric MOTION refused to forecast, with the reason, in machine form (§20). */
  readonly unavailable: ReadonlyArray<{ readonly metricKey: string; readonly reason: string }>;
  /** Per-metric working: the months used, their weights, and anything excluded as a one-off. */
  readonly breakdown: unknown;
  readonly evidenceBundleId: string | null;
  /**
   * True when the engine has run since this forecast was made, so the figures behind it have moved.
   * The page says so and offers to work it out again; it never silently shows the old numbers (§20).
   */
  readonly stale: boolean;
}

/** No history at all is a state the page renders, not an error it throws. */
export interface NoForecast {
  readonly runId: null;
  readonly reason: 'never_generated' | 'insufficient_data';
  readonly unavailable: ReadonlyArray<{ readonly metricKey: string; readonly reason: string }>;
}

export type ForecastState = ForecastView | NoForecast;

export function hasForecast(state: ForecastState): state is ForecastView {
  return state.runId !== null;
}

/** The last complete month, which is the last month a forecast may learn from. */
async function lastCompletePeriodStart(ctx: AccessContext, orgId: string): Promise<string | null> {
  const { data, error } = await ctx.db
    .from('fiscal_periods').select('period_start')
    .eq('organization_id', orgId).eq('is_complete', true)
    .order('period_start', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return (data as { period_start?: string } | null)?.period_start ?? null;
}

function groupHistory(rows: readonly repo.HistoryRow[]): Record<string, ActualPoint[]> {
  const out: Record<string, ActualPoint[]> = {};
  for (const row of rows) (out[row.metricKey] ??= []).push(row);
  return out;
}

/**
 * Work out a forecast and store it.
 *
 * `financials.view` (ADR-172 hardening, 2026-10-14; it was `dashboard.view`). A forecast is computed
 * from the whole metric history and what it stores (`forecast_runs`, `forecast_values`, its evidence)
 * is readable only with `financials.view` — `dashboard.view` stopped meaning "the figures" when the
 * 3rd party, who holds it and reads none of the detail, arrived. No new forecast permission was
 * invented: §22 forbids one that could bypass the existing matrix. `api_server.finish_forecast`
 * re-checks the same permission for the actor.
 */
export async function generateForecast(ctx: AccessContext): Promise<ForecastState> {
  assertCan(ctx, 'financials.view');
  const orgId = ctx.orgId;
  if (!orgId) throw new NotFound();

  const upTo = await lastCompletePeriodStart(ctx, orgId);
  if (upTo === null) {
    return {
      runId: null,
      reason: 'insufficient_data',
      unavailable: FORECAST_LEAVES.map((metricKey) => ({ metricKey, reason: 'no_complete_periods' })),
    };
  }

  const [history, horizon] = await Promise.all([
    repo.loadHistory(ctx.db, orgId, [...FORECAST_LEAVES, 'closing_cash'], upTo, ctx.requestId),
    repo.loadHorizon(ctx.db, orgId, upTo, HORIZON_MONTHS, ctx.requestId),
  ]);

  if (horizon.length === 0) {
    // The organisation has no future period rows. Nothing to speak about, and inventing a month is
    // exactly what this module must not do.
    return { runId: null, reason: 'insufficient_data', unavailable: [] };
  }

  const grouped = groupHistory(history);
  /*
   * The cash chain opens on the last ACTUAL closing balance — a fact on a date — never on an
   * average of recent balances (§8). Only a COMPLETE month's balance will do, for the same reason
   * the baselines ignore part-months.
   */
  const closingCash = (grouped.closing_cash ?? [])
    .filter((p) => p.isComplete && p.value !== null)
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const lastActualClosingCash = closingCash.at(-1)?.value ?? null;

  const result = composeForecast({ history: grouped, horizon, lastActualClosingCash });

  if (result.points.length === 0) {
    return {
      runId: null,
      reason: 'insufficient_data',
      unavailable: result.unavailable.map((u) => ({ metricKey: u.metricKey, reason: u.reason })),
    };
  }

  const runId = await storeForecast(ctx, orgId, result, history);
  const state = await loadForecast(ctx);
  if (!hasForecast(state)) throw new NotFound();
  void runId;
  return state;
}

/** The currency the organisation's own figures are in; never a default dressed up as a fact. */
function currencyOf(history: readonly repo.HistoryRow[]): string | null {
  return history.find((row) => row.currency !== null)?.currency ?? null;
}

async function storeForecast(
  ctx: AccessContext,
  orgId: string,
  result: ForecastResult,
  history: readonly repo.HistoryRow[],
): Promise<string> {
  const used = new Set(
    Object.values(result.baselines).flatMap((b) => b.points.filter((p) => !p.excluded).map((p) => p.periodId)),
  );
  const windowRows = history.filter((row) => used.has(row.periodId));
  const starts = [...new Set(windowRows.map((r) => r.periodStart))].sort();
  const currency = currencyOf(history);

  /*
   * The bundle's items are the snapshots the baselines actually read — deduplicated, because one
   * period contributes several metrics and an item per metric per period would be a bundle nobody
   * could read. Each carries the HISTORY's assurance; the forecast values stay `estimated`.
   */
  const basisSnapshots = windowRows
    .filter((row) => FORECAST_LEAVES.includes(row.metricKey as typeof FORECAST_LEAVES[number]))
    .map((row) => ({
      snapshot_id: row.snapshotId,
      label: `${row.metricKey} · ${row.periodLabel}`,
      assurance: row.assurance ?? 'calculated',
    }));

  const calculationRunId = windowRows.find((r) => r.calculationRunId !== null)?.calculationRunId ?? null;
  const periodIdOf = (start: string) =>
    windowRows.find((r) => r.periodStart === start)?.periodId ?? null;

  return finishForecast({
    actor: ctx.userId,
    organizationId: orgId,
    run: {
      method: result.method,
      config_version: result.configVersion,
      calculation_run_id: calculationRunId,
      basis_from_period: starts[0] === undefined ? null : periodIdOf(starts[0]),
      basis_to_period: starts.at(-1) === undefined ? null : periodIdOf(starts.at(-1)!),
      periods_used: starts.length,
      horizon_months: result.horizon.length,
      basis: result.basis,
      breakdown: Object.values(result.baselines),
      unavailable: result.unavailable,
      basis_snapshots: basisSnapshots,
      run_label: 'The calculation these figures come from',
    },
    values: result.points.map((p) => ({
      period_id: p.periodId,
      metric_key: p.metricKey,
      value: p.value,
      currency,
      derivation: p.derivation,
      derived_from: p.from,
    })),
  });
}

/**
 * Read the stored forecast back, with its actual comparison and its staleness.
 *
 * `financials.view`, as `forecast_runs` itself (RBAC_MATRIX.md §8.1): without it the read would find
 * nothing and say "never generated", which is not true — it is not theirs to see.
 */
export async function loadForecast(ctx: AccessContext): Promise<ForecastState> {
  assertCan(ctx, 'financials.view');
  const orgId = ctx.orgId;
  if (!orgId) throw new NotFound();

  const stored = await repo.loadLatestForecast(ctx.db, orgId, ctx.requestId);
  if (stored === null) return { runId: null, reason: 'never_generated', unavailable: [] };

  const upTo = await lastCompletePeriodStart(ctx, orgId);
  const [history, bundleId, currentRun] = await Promise.all([
    upTo === null
      ? Promise.resolve([] as repo.HistoryRow[])
      : repo.loadHistory(ctx.db, orgId, [...FORECAST_LEAVES, 'gross_profit', 'operating_profit',
        'net_cash_movement', 'closing_cash'], upTo, ctx.requestId),
    repo.loadForecastBundleId(ctx.db, orgId, stored.runId, ctx.requestId),
    repo.latestCalculationRunId(ctx.db, orgId, ctx.requestId),
  ]);

  const lastActualOf = (metricKey: string) => {
    const points = history
      .filter((row) => row.metricKey === metricKey && row.isComplete && row.value !== null)
      .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    const last = points.at(-1);
    if (last === undefined) return null;
    // Same shape as the forecast beside it, for the same reason (ADR-006).
    return {
      value: toMoneyString(parseDecimalOrNull(last.value!) ?? 0),
      periodLabel: last.periodLabel,
    };
  };

  const byPeriod = new Map<string, ForecastMetricView[]>();
  const labels = new Map<string, string>();
  const starts = new Map<string, string>();
  for (const value of stored.values) {
    const lastActual = lastActualOf(value.metricKey);
    const forecast = parseDecimalOrNull(value.value);
    const actual = lastActual === null ? null : parseDecimalOrNull(lastActual.value);
    const change = forecast !== null && actual !== null
      ? (forecast.minus(actual) as Decimal).toFixed(2)
      : null;

    (byPeriod.get(value.periodId) ?? byPeriod.set(value.periodId, []).get(value.periodId)!).push({
      metricKey: value.metricKey,
      value: value.value,
      currency: value.currency,
      derivation: value.derivation === 'identity' ? 'identity' : 'baseline',
      derivedFrom: value.derivedFrom,
      lastActual,
      change,
    });
  }

  const periodRows = await ctx.db
    .from('fiscal_periods').select('id, label, period_start')
    .eq('organization_id', orgId).in('id', [...byPeriod.keys()]);
  for (const row of (periodRows.data ?? []) as Array<{ id: string; label: string; period_start: string }>) {
    labels.set(row.id, row.label);
    starts.set(row.id, row.period_start);
  }

  /*
   * Ordered by the period's START DATE, never by its label. "Nov 2026" sorts before "Oct 2026"
   * before "Sep 2026" alphabetically, which would have put the three forecast months on the page
   * backwards — and a cash chain read backwards tells the reader the balance is falling when it is
   * rising.
   */
  const periods: ForecastPeriodView[] = [...byPeriod.entries()]
    .map(([periodId, metrics]) => ({
      periodId,
      periodLabel: labels.get(periodId) ?? '',
      periodStart: starts.get(periodId) ?? '',
      metrics: [...metrics].sort((a, b) => a.metricKey.localeCompare(b.metricKey)),
    }))
    .sort((a, b) => (starts.get(a.periodId) ?? '').localeCompare(starts.get(b.periodId) ?? ''));

  return {
    runId: stored.runId,
    method: stored.method,
    configVersion: stored.configVersion,
    generatedAt: stored.generatedAt,
    periodsUsed: stored.periodsUsed,
    basis: stored.basis,
    periods,
    unavailable: (stored.unavailable as Array<{ metricKey?: string; reason?: string }> | null ?? [])
      .map((u) => ({ metricKey: String(u.metricKey ?? ''), reason: String(u.reason ?? '') })),
    breakdown: stored.breakdown,
    evidenceBundleId: bundleId,
    stale: currentRun !== null && stored.calculationRunId !== null
      && currentRun !== stored.calculationRunId,
  };
}
