import 'server-only';
import { readOrganization, readRows, readRowsIn } from '@/db/app/engine-reads';
import type { Db } from '@/db/types';
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
 * Every read runs for the caller, through the ported policies (`src/db/rls.ts`), so RLS decides. The organisation is an argument the
 * service takes from the request's AccessContext, never from anything a browser sent.
 */

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
  db: Db,
  orgId: string,
  categories: readonly string[],
  upTo: string,
  requestId?: string,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const category of categories) out[category] = null;
  if (categories.length === 0) return out;

  const [pointers, periods] = await Promise.all([
    readRows(db, orgId, 'metric_current', (q) => q.where('metric_key', '==', 'expense_by_category')
      .where('dimension_type', '==', 'standard_category')),
    readRows(db, orgId, 'fiscal_periods'),
  ]);
  const wanted = new Set(categories);
  const periodById = new Map(periods.filter((p) => String(p.period_start) <= upTo).map((p) => [String(p.id), p]));
  const rows = pointers.filter((p) => wanted.has(String(p.dimension_key)) && periodById.has(String(p.period_id)));
  const snapshots = await readRowsIn(db, orgId, 'metric_snapshots', 'id', rows.map((p) => p.snapshot_id as string));
  const snapshotById = new Map(snapshots.map((x) => [String(x.id), x]));
  void requestId;

  const grouped: Record<string, ActualPoint[]> = {};
  for (const row of rows) {
    const snapshot = snapshotById.get(String(row.snapshot_id));
    const period = periodById.get(String(row.period_id));
    const key = (row.dimension_key as string | null) ?? null;
    if (!snapshot || !period || key === null) continue;
    const quality = snapshot.data_quality as { warnings?: string[] } | null;
    (grouped[key] ??= []).push({
      periodId: String(row.period_id),
      periodStart: String(period.period_start),
      periodLabel: String(period.label),
      value: snapshot.value === null || snapshot.value === undefined ? null : String(snapshot.value),
      isComplete: period.is_complete === true,
      assurance: (snapshot.assurance_level as AssuranceLevel | null) ?? null,
      warnings: quality?.warnings ?? [],
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
  db: Db, orgId: string, requestId?: string,
): Promise<string | null> {
  void requestId;
  const rows = await readRows(db, orgId, 'fiscal_periods', (q) => q.where('is_complete', '==', true));
  return rows.map((r) => String(r.period_start)).sort().at(-1) ?? null;
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
 * A `numeric(20,6)` is stored as `10000.000000` (PostgREST used to hand back `10000`) — the same
 * figure in different shapes, which is how a page ends up rendering a baseline and a scenario
 * differently. Money is re-parsed to a Decimal at the
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

const newestFirst = (a: Record<string, unknown>, b: Record<string, unknown>): number =>
  (String(a.created_at) < String(b.created_at) ? 1 : String(a.created_at) > String(b.created_at) ? -1 : 0);

/** A run with its figures (the old embedded `scenario_values (...)`). */
async function withValues(db: Db, orgId: string, run: Record<string, unknown>): Promise<StoredScenarioRow> {
  const values = await readRows(db, orgId, 'scenario_values', (q) => q.where('scenario_run_id', '==', run.id));
  return toStored({ ...run, scenario_values: values } as unknown as RunRow);
}

/** One saved scenario with its figures. `null` when the id is not this organisation's. */
export async function loadScenarioById(
  db: Db, orgId: string, scenarioId: string, requestId?: string,
): Promise<StoredScenarioRow | null> {
  void requestId;
  const rows = await readRows(db, orgId, 'scenario_runs', (q) => q.where('id', '==', scenarioId));
  return rows[0] ? withValues(db, orgId, rows[0]) : null;
}

/** The most recently worked-out scenario that has not been put away. */
export async function loadLatestScenario(
  db: Db, orgId: string, requestId?: string,
): Promise<StoredScenarioRow | null> {
  void requestId;
  // Equality only, newest picked here: no composite index on (archived_at, created_at).
  const rows = (await readRows(db, orgId, 'scenario_runs', (q) => q.where('archived_at', '==', null))).sort(newestFirst);
  return rows[0] ? withValues(db, orgId, rows[0]) : null;
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
  db: Db, orgId: string, includeArchived: boolean, requestId?: string,
): Promise<ScenarioSummaryRow[]> {
  void requestId;
  const rows = (await readRows(db, orgId, 'scenario_runs', includeArchived ? undefined : (q) => q.where('archived_at', '==', null)))
    .sort(newestFirst).slice(0, 50);
  return rows.map((row) => ({
    runId: String(row.id),
    name: String(row.name),
    createdAt: String(row.created_at),
    archivedAt: (row.archived_at as string | null) ?? null,
    assumptions: row.assumptions,
  }));
}

async function bundleOf(db: Db, orgId: string, originTable: string, originId: string): Promise<string | null> {
  const rows = (await readRows(db, orgId, 'evidence_bundles', (q) => q.where('origin_id', '==', originId)))
    .filter((b) => b.origin_table === originTable);
  return rows[0] ? String(rows[0].id) : null;
}

/** The evidence bundle a stored scenario produced, for the "Why?" affordance. */
export async function loadScenarioBundleId(
  db: Db, orgId: string, runId: string, requestId?: string,
): Promise<string | null> {
  void requestId;
  return bundleOf(db, orgId, 'scenario_runs', runId);
}

/** The forecast bundle whose items a new scenario copies (EVIDENCE_MODEL.md §5). */
export async function loadForecastBundleId(
  db: Db, orgId: string, forecastRunId: string, requestId?: string,
): Promise<string | null> {
  void requestId;
  return bundleOf(db, orgId, 'forecast_runs', forecastRunId);
}

/**
 * The id of the newest forecast, and nothing else.
 *
 * A scenario read needs one fact about the forecast — whether the one it was made from is still the
 * current one — and asking `loadForecast` for it would cost five queries to learn an id. Staleness
 * is a stated fact, not a cache, so the cheapest true answer is the right one (§22).
 */
export async function latestForecastRunId(
  db: Db, orgId: string, requestId?: string,
): Promise<string | null> {
  void requestId;
  const rows = await readRows(db, orgId, 'forecast_runs', (q) => q.orderBy('generated_at', 'desc').limit(1));
  return rows[0] ? String(rows[0].id) : null;
}

/**
 * The organisation's configured currency (`organizations.base_currency`).
 *
 * Every money figure a scenario renders or hands to the analyst is formatted in this, never in a
 * default and never in anything the browser sent. The forecast's own cells carry the same code, and
 * the two are expected to agree; the organisation's setting is the one a person can see and change,
 * so it is the one that wins (remediation of MEDIUM-3, `PHASE_12_REMEDIATION.md`).
 */
export async function loadBaseCurrency(
  db: Db, orgId: string, requestId?: string,
): Promise<string | null> {
  void requestId;
  const org = await readOrganization(db, orgId);
  const code = (org?.base_currency as string | null | undefined) ?? null;
  return code === null ? null : code.trim();
}

/** The calculation run the forecast rested on, carried onto the scenario's own bundle. */
export async function forecastCalculationRunId(
  db: Db, orgId: string, forecastRunId: string, requestId?: string,
): Promise<string | null> {
  void requestId;
  const rows = await readRows(db, orgId, 'forecast_runs', (q) => q.where('id', '==', forecastRunId));
  return (rows[0]?.calculation_run_id as string | null | undefined) ?? null;
}
