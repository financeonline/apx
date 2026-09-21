import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import { parseDecimalOrNull, toMoneyString } from '@/core/money';
import type { AssuranceLevel } from '@/core/assurance';
import { buildBaseline, selectWindow, type ActualPoint } from '@/modules/forecast';

/**
 * What a scenario reads (ADR-100).
 *
 * A short list and nothing else: the `expense_by_category` levels a percentage assumption needs,
 * the last month a level may be drawn from, scenarios that were saved earlier, and two ids about
 * the forecast. The forecast's FIGURES are not read here — the service asks `modules/forecast` for
 * those, because a second reader of `forecast_values` would be a second definition of what a
 * baseline is. The only thing read from `forecast_runs` directly is an id.
 *
 * Every read runs on the caller's own client, so RLS decides. The organisation is an argument the
 * service takes from the request's AccessContext, never from anything a browser sent.
 */

interface CategoryRow {
  metric_key: string;
  period_id: string;
  dimension_key: string | null;
  metric_snapshots: {
    value: string | null;
    assurance_level: AssuranceLevel | null;
    data_quality: { warnings?: string[] } | null;
  } | null;
  fiscal_periods: { period_start: string; label: string; is_complete: boolean } | null;
}

/**
 * What each named spending category has been running at, as a recency-weighted level.
 *
 * `+5% of wages` is unanswerable without knowing what wages have been, and the only figure in
 * MOTION that says so is the engine's own `expense_by_category` breakdown with
 * `dimension_key = 'payroll'` (FINANCIAL_ENGINE.md §3.1). The level is built with the FORECAST's
 * `selectWindow` and `buildBaseline` — the same sufficiency, continuity, one-off and recency rules
 * the forecast applies to every other leaf — so a category level and a forecast level are the same
 * kind of statement, computed by the same code.
 *
 * A category with too little history comes back `null`, and the scenario refuses the percentage
 * rather than guessing at it (§7).
 */
export async function loadCategoryLevels(
  db: SupabaseClient,
  orgId: string,
  categories: readonly string[],
  upTo: string,
  requestId?: string,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const category of categories) out[category] = null;
  if (categories.length === 0) return out;

  const { data, error } = await db
    .from('metric_current')
    .select(`
      metric_key, period_id, dimension_key,
      metric_snapshots!inner ( value, assurance_level, data_quality ),
      fiscal_periods!inner ( period_start, label, is_complete )`)
    .eq('organization_id', orgId)
    .eq('metric_key', 'expense_by_category')
    .eq('dimension_type', 'standard_category')
    .in('dimension_key', [...categories])
    .lte('fiscal_periods.period_start', upTo);
  if (error) throw toMotionError(error, requestId);

  const grouped: Record<string, ActualPoint[]> = {};
  for (const row of ((data ?? []) as unknown as CategoryRow[])) {
    const snapshot = row.metric_snapshots;
    const period = row.fiscal_periods;
    const key = row.dimension_key;
    if (!snapshot || !period || key === null) continue;
    (grouped[key] ??= []).push({
      periodId: row.period_id,
      periodStart: period.period_start,
      periodLabel: period.label,
      value: snapshot.value === null ? null : String(snapshot.value),
      isComplete: period.is_complete,
      assurance: snapshot.assurance_level,
      warnings: snapshot.data_quality?.warnings ?? [],
    });
  }

  for (const [category, points] of Object.entries(grouped)) {
    const verdict = selectWindow(points);
    out[category] = verdict.ok ? buildBaseline(category, verdict.window).value : null;
  }
  return out;
}

/** The last finished month, which is the last month any level may be drawn from. */
export async function lastCompletePeriodStart(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('fiscal_periods').select('period_start')
    .eq('organization_id', orgId).eq('is_complete', true)
    .order('period_start', { ascending: false }).limit(1).maybeSingle();
  if (error) throw toMotionError(error, requestId);
  return (data as { period_start?: string } | null)?.period_start ?? null;
}

export interface StoredScenarioRow {
  readonly runId: string;
  readonly name: string;
  readonly forecastRunId: string;
  readonly method: string;
  readonly configVersion: string;
  readonly assumptions: unknown;
  readonly horizonMonths: number;
  readonly basis: 'strong' | 'limited' | 'weak' | null;
  readonly dataQuality: unknown;
  readonly unavailable: unknown;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly values: ReadonlyArray<{
    readonly periodId: string;
    readonly metricKey: string;
    readonly baselineValue: string;
    readonly scenarioValue: string;
    readonly currency: string | null;
    readonly derivation: string;
    readonly derivedFrom: readonly string[];
  }>;
}

const RUN_COLUMNS = `id, name, forecast_run_id, method, config_version, assumptions,
  horizon_months, basis, data_quality, unavailable, archived_at, created_at`;

interface RunRow {
  id: string; name: string; forecast_run_id: string; method: string; config_version: string;
  assumptions: unknown; horizon_months: number;
  basis: StoredScenarioRow['basis']; data_quality: unknown; unavailable: unknown;
  archived_at: string | null; created_at: string;
  scenario_values?: Array<{
    period_id: string; metric_key: string; baseline_value: string; scenario_value: string;
    currency: string | null; derivation: string; derived_from: string[] | null;
  }> | null;
}

/*
 * PostgREST hands a `numeric` back as a JSON number, so `String()` alone would turn the `10000.00`
 * the engine wrote into `10000` — the same figure in a different shape, which is how a page ends up
 * rendering a baseline and a scenario differently. Money is re-parsed to a Decimal at the
 * data-access boundary and re-emitted in one shape, which is what ADR-006 asks of every reader.
 */
const shaped = (value: string): string => toMoneyString(parseDecimalOrNull(String(value)) ?? 0);

function toStored(row: RunRow): StoredScenarioRow {
  return {
    runId: row.id,
    name: row.name,
    forecastRunId: row.forecast_run_id,
    method: row.method,
    configVersion: row.config_version,
    assumptions: row.assumptions,
    horizonMonths: row.horizon_months,
    basis: row.basis,
    dataQuality: row.data_quality,
    unavailable: row.unavailable,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    values: (row.scenario_values ?? []).map((v) => ({
      periodId: v.period_id,
      metricKey: v.metric_key,
      baselineValue: shaped(v.baseline_value),
      scenarioValue: shaped(v.scenario_value),
      currency: v.currency,
      derivation: v.derivation,
      derivedFrom: v.derived_from ?? [],
    })),
  };
}

const WITH_VALUES = `${RUN_COLUMNS},
  scenario_values ( period_id, metric_key, baseline_value, scenario_value, currency, derivation, derived_from )`;

/** One saved scenario with its figures. `null` when the id is not this organisation's. */
export async function loadScenarioById(
  db: SupabaseClient, orgId: string, scenarioId: string, requestId?: string,
): Promise<StoredScenarioRow | null> {
  const { data, error } = await db
    .from('scenario_runs').select(WITH_VALUES)
    .eq('organization_id', orgId).eq('id', scenarioId).maybeSingle();
  if (error) throw toMotionError(error, requestId);
  return data === null ? null : toStored(data as unknown as RunRow);
}

/** The most recently worked-out scenario that has not been put away. */
export async function loadLatestScenario(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<StoredScenarioRow | null> {
  const { data, error } = await db
    .from('scenario_runs').select(WITH_VALUES)
    .eq('organization_id', orgId).is('archived_at', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw toMotionError(error, requestId);
  return data === null ? null : toStored(data as unknown as RunRow);
}

export interface ScenarioSummaryRow {
  readonly runId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly assumptions: unknown;
}

/** The list, newest first. Figures are not read: a list of names does not need them. */
export async function listScenarioRows(
  db: SupabaseClient, orgId: string, includeArchived: boolean, requestId?: string,
): Promise<ScenarioSummaryRow[]> {
  let query = db
    .from('scenario_runs').select('id, name, created_at, archived_at, assumptions')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (!includeArchived) query = query.is('archived_at', null);

  const { data, error } = await query;
  if (error) throw toMotionError(error, requestId);
  return ((data ?? []) as Array<{
    id: string; name: string; created_at: string; archived_at: string | null; assumptions: unknown;
  }>).map((row) => ({
    runId: row.id,
    name: row.name,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    assumptions: row.assumptions,
  }));
}

/** The evidence bundle a stored scenario produced, for the "Why?" affordance. */
export async function loadScenarioBundleId(
  db: SupabaseClient, orgId: string, runId: string, requestId?: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('evidence_bundles').select('id')
    .eq('organization_id', orgId).eq('origin_table', 'scenario_runs').eq('origin_id', runId)
    .maybeSingle();
  if (error) throw toMotionError(error, requestId);
  return (data as { id?: string } | null)?.id ?? null;
}

/** The forecast bundle whose items a new scenario copies (EVIDENCE_MODEL.md §5). */
export async function loadForecastBundleId(
  db: SupabaseClient, orgId: string, forecastRunId: string, requestId?: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('evidence_bundles').select('id')
    .eq('organization_id', orgId).eq('origin_table', 'forecast_runs').eq('origin_id', forecastRunId)
    .maybeSingle();
  if (error) throw toMotionError(error, requestId);
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * The id of the newest forecast, and nothing else.
 *
 * A scenario read needs one fact about the forecast — whether the one it was made from is still the
 * current one — and asking `loadForecast` for it would cost five queries to learn an id. Staleness
 * is a stated fact, not a cache, so the cheapest true answer is the right one (§22).
 */
export async function latestForecastRunId(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('forecast_runs').select('id')
    .eq('organization_id', orgId)
    .order('generated_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw toMotionError(error, requestId);
  return (data as { id?: string } | null)?.id ?? null;
}

/** The calculation run the forecast rested on, carried onto the scenario's own bundle. */
export async function forecastCalculationRunId(
  db: SupabaseClient, orgId: string, forecastRunId: string, requestId?: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('forecast_runs').select('calculation_run_id')
    .eq('organization_id', orgId).eq('id', forecastRunId).maybeSingle();
  if (error) throw toMotionError(error, requestId);
  return (data as { calculation_run_id?: string | null } | null)?.calculation_run_id ?? null;
}
