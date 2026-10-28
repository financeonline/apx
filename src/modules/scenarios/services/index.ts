import 'server-only';
import { callApi, finishScenario } from '@/core/db';
import { assertCan } from '@/core/permissions';
import { NotFound, ValidationError } from '@/core/errors';
import { Decimal, parseDecimalOrNull, toMoneyString, toRatioString } from '@/core/money';
import { hasForecast, loadForecast, type ForecastView, type HorizonPeriod } from '@/modules/forecast';
import type { AccessContext } from '@/modules/tenancy';
import {
  CATEGORY_FOR_KIND, SCENARIO_CONFIG_VERSION, SCENARIO_METHOD, type AssumptionKind,
} from '../domain/config';
import { parseAssumptions } from '../domain/assumptions';
import { applyScenario } from '../domain/apply';
import type {
  Assumption, ScenarioBasis, ScenarioCell, ScenarioUnavailable,
} from '../domain/types';
import { readRowsIn } from '@/db/app/engine-reads';
import * as repo from '../data/repository';

/**
 * The scenario service (REQ-SC-01…10; ADR-100).
 *
 * **The forecast is the baseline, and this module does not recompute it.** Every figure a scenario
 * starts from is one `modules/forecast` already produced from the engine's own snapshots. What this
 * module adds is a set of stated assumptions and the deltas they imply; the arithmetic that turns
 * leaves into profit and cash is the forecast's own `composeFromLevels`, called for both sides.
 *
 * **Worked out when asked, and stored whole.** Like a forecast (ADR-099) and an evidence bundle
 * (ADR-066), a scenario is written when somebody asks for one — and then it never changes. A saved
 * scenario holds BOTH figures per cell, so regenerating the forecast underneath it cannot rewrite
 * what it said (§13).
 *
 * **Two permissions, on purpose.** Reading is `financials.view` — a scenario is a statement about
 * figures, and everyone who may see the figures may see it, a client included (ADR-172: it was
 * `dashboard.view` until a 3rd party held that without the figures; `scenario_runs` is
 * `financials.view` reading). Working one out is
 * `intelligence.recompute`, which is the permission for triggering a deterministic calculation over
 * the organisation's figures and which a client does not hold. No new permission was invented (§19,
 * §22).
 */

export interface ScenarioMetricView {
  readonly metricKey: string;
  readonly baselineValue: string;
  readonly scenarioValue: string;
  readonly change: string;
  readonly changeRatio: string | null;
  readonly currency: string | null;
  readonly derivation: 'baseline' | 'identity';
  readonly derivedFrom: readonly string[];
}

export interface ScenarioPeriodView {
  readonly periodId: string;
  readonly periodLabel: string;
  readonly metrics: readonly ScenarioMetricView[];
}

export interface ScenarioView {
  readonly runId: string;
  readonly name: string;
  readonly method: string;
  readonly configVersion: string;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly basis: 'strong' | 'limited' | 'weak' | null;
  readonly assumptions: readonly Assumption[];
  readonly periods: readonly ScenarioPeriodView[];
  /**
   * The organisation's configured currency (`organizations.base_currency`), which every money
   * figure on the page and in the analyst's tool is formatted in. Never a default dressed up as a
   * fact: it falls back to the forecast's own cell currency only when the setting is absent.
   */
  readonly currency: string;
  /**
   * Inherited from the forecast: the data-quality warnings on the figures the baseline was built
   * from, flattened and deduplicated across metrics, plus the metrics the forecast refused (§12).
   * Stored on the run at save time, so a saved scenario keeps disclosing what its baseline carried
   * even after the forecast has been regenerated.
   */
  readonly dataQuality: {
    readonly warnings: readonly string[];
    readonly forecastUnavailable: ReadonlyArray<{ metricKey: string; reason: string }>;
  };
  readonly evidenceBundleId: string | null;
  /** True when the forecast this rests on is no longer the newest one (§13). */
  readonly stale: boolean;
}

/** A scenario that was not worked out, and the real condition that stopped it (§7). */
export interface NoScenario {
  readonly runId: null;
  readonly unavailable: readonly ScenarioUnavailable[];
}

export type ScenarioState = ScenarioView | NoScenario;

export function hasScenario(state: ScenarioState): state is ScenarioView {
  return state.runId !== null;
}

export interface ScenarioSummary {
  readonly runId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly assumptions: readonly Assumption[];
}

const orgOf = (ctx: AccessContext): string => {
  if (!ctx.orgId) throw new NotFound();
  return ctx.orgId;
};

/** Assumptions read back out of a stored row, tolerantly: a saved scenario must still open. */
function storedAssumptions(value: unknown): Assumption[] {
  if (!Array.isArray(value)) return [];
  return value as Assumption[];
}

/** One metric's inherited warnings, as stored on `scenario_runs.data_quality.forecast_warnings`. */
export interface ForecastWarning {
  readonly metricKey: string;
  readonly warnings: readonly string[];
}

/**
 * The per-metric warnings out of a forecast's stored `breakdown` (`Baseline[]`, ADR-099).
 *
 * Only entries that actually carry a warning are kept, and only string codes: the engine writes
 * warnings as codes (`FINANCIAL_ENGINE.md §5`) and the page renders them through the same
 * plain-English table the analyst's confidence line uses, so nothing free-text reaches a reader.
 */
export function forecastWarningsOf(breakdown: unknown): ForecastWarning[] {
  if (!Array.isArray(breakdown)) return [];
  const out: ForecastWarning[] = [];
  for (const entry of breakdown) {
    if (entry === null || typeof entry !== 'object') continue;
    const { metricKey, warnings } = entry as { metricKey?: unknown; warnings?: unknown };
    if (typeof metricKey !== 'string' || !Array.isArray(warnings)) continue;
    const codes = warnings.filter((w): w is string => typeof w === 'string' && w.length > 0);
    if (codes.length > 0) out.push({ metricKey, warnings: [...new Set(codes)].sort() });
  }
  return out;
}

/**
 * The levels a scenario moves, recovered from the forecast the user is looking at.
 *
 * `cost_of_sales` and the opening cash balance are not stored as forecast figures — the forecast
 * reports profit and closing cash, not the inputs behind them — so both are recovered by the
 * engine's own identities:
 *
 *     cost_of_sales   = revenue − gross profit
 *     opening balance = closing cash (month 1) − change in cash (month 1)
 *
 * Both are exact, and both come out of the SAME stored run the baseline column will quote, which is
 * what keeps the two halves of the comparison about one thing.
 */
export function basisFromForecast(forecast: ForecastView): ScenarioBasis {
  const first = forecast.periods[0];
  const value = (key: string): string | null =>
    first?.metrics.find((m) => m.metricKey === key)?.value ?? null;

  const revenue = value('revenue');
  const grossProfit = value('gross_profit');
  const closingCash = value('closing_cash');
  const movement = value('net_cash_movement');

  // Decimal, never a float: these two are money and ADR-006 admits no exception for a subtraction
  // that "looks safe". `0.1 + 0.2` is the reason.
  const minus = (a: string | null, b: string | null): string | null => {
    const left = a === null ? null : parseDecimalOrNull(a);
    const right = b === null ? null : parseDecimalOrNull(b);
    return left === null || right === null ? null : toMoneyString(left.minus(right));
  };

  return {
    leafLevels: {
      revenue,
      // CD-05: no gross profit means no cost-of-sales accounts, so there are no direct costs.
      cost_of_sales: revenue !== null && grossProfit !== null ? minus(revenue, grossProfit) : null,
      operating_expenses: value('operating_expenses'),
      cash_inflows: value('cash_inflows'),
      cash_outflows: value('cash_outflows'),
      receivables: value('receivables'),
      payables: value('payables'),
    },
    categoryLevels: {},
    lastActualClosingCash: minus(closingCash, movement),
  };
}

function horizonOf(forecast: ForecastView): HorizonPeriod[] {
  return forecast.periods.map((period) => ({
    periodId: period.periodId,
    periodStart: period.periodStart,
    periodLabel: period.periodLabel,
  }));
}

function currencyOf(forecast: ForecastView): string | null {
  for (const period of forecast.periods) {
    for (const metric of period.metrics) if (metric.currency !== null) return metric.currency;
  }
  return null;
}

/** The spending categories the chosen assumptions need a level for, and no others. */
function categoriesNeeded(assumptions: readonly Assumption[]): string[] {
  const out = new Set<string>();
  for (const assumption of assumptions) {
    if (!('mode' in assumption) || assumption.mode !== 'percent') continue;
    const category = CATEGORY_FOR_KIND[assumption.kind as AssumptionKind];
    if (category !== undefined) out.add(category);
  }
  return [...out];
}

export interface RunScenarioInput {
  readonly name: string;
  /** Raw, as the form sent it. Parsed and checked here — never trusted (§4, §19). */
  readonly assumptions: unknown;
}

/**
 * Work a scenario out and save it.
 *
 * Nothing is stored when anything is refused: a scenario that had some of its assumptions applied
 * would sit in the list looking like an answer (§7).
 */
export async function runScenario(
  ctx: AccessContext, input: RunScenarioInput,
): Promise<ScenarioState> {
  assertCan(ctx, 'intelligence.recompute');
  const orgId = orgOf(ctx);

  const name = input.name.trim();
  if (name.length === 0 || name.length > 120) {
    throw new ValidationError('Give this scenario a short name so you can find it again.', [
      { path: 'name', message: 'A name between 1 and 120 characters is needed.' },
    ]);
  }

  // Parsed BEFORE anything is read, so a malformed assumption costs no database work.
  const assumptions = parseAssumptions(input.assumptions);

  const forecast = await loadForecast(ctx);
  if (!hasForecast(forecast) || forecast.periods.length === 0) {
    return {
      runId: null,
      unavailable: [{ kind: assumptions[0]!.kind, reason: 'no_forecast', metricKey: null }],
    };
  }

  const upTo = await repo.lastCompletePeriodStart(ctx.db, orgId, ctx.requestId);
  const categoryLevels = upTo === null
    ? {}
    : await repo.loadCategoryLevels(
      ctx.db, orgId, categoriesNeeded(assumptions), upTo, ctx.requestId);

  const basis: ScenarioBasis = { ...basisFromForecast(forecast), categoryLevels };
  const result = applyScenario({
    assumptions,
    basis,
    horizon: horizonOf(forecast),
    forecastBasis: forecast.basis,
  });

  if (result.unavailable.length > 0 || result.cells.length === 0) {
    return {
      runId: null,
      unavailable: result.unavailable.length > 0
        ? result.unavailable
        : [{ kind: assumptions[0]!.kind, reason: 'no_forecast', metricKey: null }],
    };
  }

  const runId = await storeScenario(ctx, orgId, name, assumptions, forecast, result.cells);
  const state = await loadScenario(ctx, runId);
  if (!hasScenario(state)) throw new NotFound();
  return state;
}

async function storeScenario(
  ctx: AccessContext,
  orgId: string,
  name: string,
  assumptions: readonly Assumption[],
  forecast: ForecastView,
  cells: readonly ScenarioCell[],
): Promise<string> {
  const [forecastBundleId, calculationRunId, baseCurrency] = await Promise.all([
    repo.loadForecastBundleId(ctx.db, orgId, forecast.runId, ctx.requestId),
    repo.forecastCalculationRunId(ctx.db, orgId, forecast.runId, ctx.requestId),
    repo.loadBaseCurrency(ctx.db, orgId, ctx.requestId),
  ]);
  // The organisation's setting first; the forecast's own cell currency only if it has none.
  const currency = baseCurrency ?? currencyOf(forecast);

  /*
   * §12: the warnings the forecast's baselines inherited from the engine's snapshots
   * (`cash_basis_proxy`, `bank_coverage_partial`, …) are copied onto the scenario at save time.
   * `forecast_runs.breakdown` is the forecast's `Baseline[]`, each carrying the warnings of the
   * months it averaged; a scenario that dropped them would present a clean sheet over a baseline
   * the forecast itself had flagged. Read defensively: it is `unknown` on the view because it is
   * stored jsonb, and a malformed entry contributes nothing rather than throwing.
   */
  const forecastWarnings = forecastWarningsOf(forecast.breakdown);

  return finishScenario({
    actor: ctx.userId,
    organizationId: orgId,
    run: {
      name,
      forecast_run_id: forecast.runId,
      method: SCENARIO_METHOD,
      config_version: SCENARIO_CONFIG_VERSION,
      assumptions,
      horizon_months: forecast.periods.length,
      basis: forecast.basis,
      // §12: the scenario inherits the forecast's own caveats rather than presenting a clean sheet.
      data_quality: {
        forecast_basis: forecast.basis,
        forecast_config_version: forecast.configVersion,
        forecast_stale_at_creation: forecast.stale,
        forecast_unavailable: forecast.unavailable,
        forecast_warnings: forecastWarnings,
      },
      unavailable: [],
      forecast_bundle_id: forecastBundleId,
      calculation_run_id: calculationRunId,
    },
    values: cells.map((cell) => ({
      period_id: cell.periodId,
      metric_key: cell.metricKey,
      baseline_value: cell.baselineValue,
      scenario_value: cell.scenarioValue,
      currency,
      derivation: cell.derivation,
      derived_from: cell.derivedFrom,
    })),
  });
}

interface StoredQuality {
  forecast_unavailable?: Array<{ metricKey?: string; reason?: string }>;
  forecast_warnings?: Array<{ metricKey?: string; warnings?: string[] }>;
}

async function viewOf(
  ctx: AccessContext, orgId: string, stored: repo.StoredScenarioRow,
): Promise<ScenarioView> {
  const [bundleId, latestForecastRunId, baseCurrency] = await Promise.all([
    repo.loadScenarioBundleId(ctx.db, orgId, stored.runId, ctx.requestId),
    repo.latestForecastRunId(ctx.db, orgId, ctx.requestId),
    repo.loadBaseCurrency(ctx.db, orgId, ctx.requestId),
  ]);

  const byPeriod = new Map<string, ScenarioMetricView[]>();
  for (const value of stored.values) {
    const metrics = byPeriod.get(value.periodId) ?? [];
    const baseline = parseDecimalOrNull(value.baselineValue) ?? new Decimal(0);
    const scenario = parseDecimalOrNull(value.scenarioValue) ?? new Decimal(0);
    const change = scenario.minus(baseline);
    metrics.push({
      metricKey: value.metricKey,
      baselineValue: value.baselineValue,
      scenarioValue: value.scenarioValue,
      change: toMoneyString(change),
      // FINANCIAL_ENGINE.md §3.2: a percentage across zero is meaningless; the money still stands.
      changeRatio: baseline.isZero() ? null : toRatioString(change.dividedBy(baseline.abs())),
      currency: value.currency,
      derivation: value.derivation === 'identity' ? 'identity' : 'baseline',
      derivedFrom: value.derivedFrom,
    });
    byPeriod.set(value.periodId, metrics);
  }

  const data = await readRowsIn(ctx.db, orgId, 'fiscal_periods', 'id', [...byPeriod.keys()]);
  const labels = new Map<string, string>();
  const starts = new Map<string, string>();
  for (const row of (data as Array<{ id: string; label: string; period_start: string }>)) {
    labels.set(row.id, row.label);
    starts.set(row.id, row.period_start);
  }

  /*
   * Ordered by the period's START DATE, never by its label — "Nov 2026" sorts before "Oct 2026"
   * before "Sep 2026" alphabetically, and a cash chain read backwards says a balance is falling
   * when it is rising. The same defect Phase 11 found on the forecast page.
   */
  const periods: ScenarioPeriodView[] = [...byPeriod.entries()]
    .map(([periodId, metrics]) => ({
      periodId,
      periodLabel: labels.get(periodId) ?? '',
      metrics,
    }))
    .sort((a, b) => (starts.get(a.periodId) ?? '').localeCompare(starts.get(b.periodId) ?? ''));

  const quality = (stored.dataQuality ?? {}) as StoredQuality;
  // Flattened across metrics and deduplicated: the page says "the figures this rests on carry these
  // notes", once each, rather than the same note for every metric that inherited it.
  const warnings = [...new Set(
    (quality.forecast_warnings ?? [])
      .flatMap((item) => (Array.isArray(item.warnings) ? item.warnings : []))
      .filter((w): w is string => typeof w === 'string' && w.length > 0),
  )].sort();

  return {
    runId: stored.runId,
    name: stored.name,
    method: stored.method,
    configVersion: stored.configVersion,
    createdAt: stored.createdAt,
    archivedAt: stored.archivedAt,
    basis: stored.basis,
    assumptions: storedAssumptions(stored.assumptions),
    periods,
    // The organisation's setting; the stored cells' currency only if the setting is absent.
    currency: baseCurrency ?? stored.values.find((v) => v.currency !== null)?.currency ?? 'GBP',
    dataQuality: {
      warnings,
      forecastUnavailable: (quality.forecast_unavailable ?? []).map((item) => ({
        metricKey: String(item.metricKey ?? ''),
        reason: String(item.reason ?? ''),
      })),
    },
    evidenceBundleId: bundleId,
    /*
     * §13: the saved figures never move. What CAN change is whether the forecast underneath is
     * still the one this was worked out from — so that is said, and the reader decides whether to
     * run it again. Nothing is silently recalculated.
     */
    stale: latestForecastRunId !== null && latestForecastRunId !== stored.forecastRunId,
  };
}

/** One saved scenario, by id, or the most recent one when no id is given. */
export async function loadScenario(
  ctx: AccessContext, scenarioId?: string,
): Promise<ScenarioState> {
  assertCan(ctx, 'financials.view');
  const orgId = orgOf(ctx);

  const stored = scenarioId === undefined
    ? await repo.loadLatestScenario(ctx.db, orgId, ctx.requestId)
    : await repo.loadScenarioById(ctx.db, orgId, scenarioId, ctx.requestId);
  if (stored === null) return { runId: null, unavailable: [] };

  return viewOf(ctx, orgId, stored);
}

/** Every scenario this organisation has saved, newest first. */
export async function listScenarios(
  ctx: AccessContext, { includeArchived = false } = {},
): Promise<ScenarioSummary[]> {
  assertCan(ctx, 'financials.view');
  const rows = await repo.listScenarioRows(ctx.db, orgOf(ctx), includeArchived, ctx.requestId);
  return rows.map((row) => ({
    runId: row.runId,
    name: row.name,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
    assumptions: storedAssumptions(row.assumptions),
  }));
}

/**
 * Put a scenario away, or bring it back.
 *
 * Archiving rather than deleting: the scenario's evidence bundle points at the row, and a deleted
 * row would leave a bundle citing something that no longer exists (EVIDENCE_MODEL.md §8).
 */
export async function archiveScenario(
  ctx: AccessContext, scenarioId: string, archived = true,
): Promise<string> {
  assertCan(ctx, 'intelligence.recompute');
  return callApi<string>(ctx.db, 'archive_scenario', {
    p_scenario: scenarioId, p_archived: archived,
  }, ctx.requestId);
}
