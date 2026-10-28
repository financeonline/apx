import 'server-only';
import { readRows, readRowsIn } from '@/db/app/engine-reads';
import type { Db } from '@/db/types';
import { parseDecimalOrNull, toMoneyString } from '@/core/money';
import type { AssuranceLevel } from '@/core/assurance';
import type { ActualPoint, HorizonPeriod } from '../domain/types';

/**
 * Reading the history a forecast rests on, and reading a forecast back (ADR-099).
 *
 * **Every actual comes from `metric_current` joined to `metric_snapshots`** — the same rule the
 * dashboard obeys, for the same reason: reading `metric_snapshots` directly could take a figure from
 * a superseded run, and computing anything here would put a second definition of a metric outside
 * the engine. The forecast module computes a baseline OVER the engine's figures; it never computes a
 * figure.
 *
 * Every read runs for the caller, through the ported policies (`src/db/rls.ts`), so RLS decides. The organisation is an argument the
 * service takes from the request's AccessContext, never from anything a browser sent.
 */

export interface HistoryRow extends ActualPoint {
  readonly metricKey: string;
  /** The snapshot behind the figure, which is what the forecast's evidence cites. */
  readonly snapshotId: string;
  readonly currency: string | null;
  readonly calculationRunId: string | null;
}

/**
 * The history for a set of metrics, oldest first.
 *
 * `dimension_type = 'none'` because a forecast is about the business, not about one account or one
 * customer. Only periods on or before `upTo` are read: a forecast must not learn from a period it
 * is about to forecast, and the current part-month is excluded by the completeness rule anyway.
 */
export async function loadHistory(
  db: Db,
  orgId: string,
  metricKeys: readonly string[],
  upTo: string,
  requestId?: string,
): Promise<HistoryRow[]> {
  void requestId;
  const [pointers, periods] = await Promise.all([
    readRowsIn(db, orgId, 'metric_current', 'metric_key', metricKeys, (q) => q.where('dimension_type', '==', 'none')),
    readRows(db, orgId, 'fiscal_periods'),
  ]);
  const periodById = new Map(periods.filter((p) => String(p.period_start) <= upTo).map((p) => [String(p.id), p]));
  const inWindow = pointers.filter((p) => periodById.has(String(p.period_id)))
    .sort((a, b) => (String(a.period_id) < String(b.period_id) ? -1 : String(a.period_id) > String(b.period_id) ? 1 : 0));
  const snapshots = await readRowsIn(db, orgId, 'metric_snapshots', 'id', inWindow.map((p) => p.snapshot_id as string));
  const snapshotById = new Map(snapshots.map((s) => [String(s.id), s]));

  return inWindow.flatMap((row) => {
    const snapshot = snapshotById.get(String(row.snapshot_id));
    const period = periodById.get(String(row.period_id));
    if (!snapshot || !period) return [];
    const quality = snapshot.data_quality as { warnings?: string[] } | null;
    return [{
      metricKey: String(row.metric_key),
      snapshotId: String(snapshot.id),
      periodId: String(row.period_id),
      periodStart: String(period.period_start),
      periodLabel: String(period.label),
      value: snapshot.value === null || snapshot.value === undefined ? null : String(snapshot.value),
      isComplete: period.is_complete === true,
      assurance: (snapshot.assurance_level as AssuranceLevel | null) ?? null,
      warnings: quality?.warnings ?? [],
      currency: (snapshot.currency as string | null) ?? null,
      calculationRunId: (snapshot.calculation_run_id as string | null) ?? null,
    }];
  });
}

/** The months a forecast will speak about: real period rows strictly after the last actual one. */
export async function loadHorizon(
  db: Db, orgId: string, after: string, months: number, requestId?: string,
): Promise<HorizonPeriod[]> {
  void requestId;
  const rows = await readRows(db, orgId, 'fiscal_periods', (q) => q.where('period_start', '>', after)
    .orderBy('period_start', 'asc').limit(months));
  return rows.map((row) => ({ periodId: String(row.id), periodStart: String(row.period_start), periodLabel: String(row.label) }));
}

export interface StoredForecast {
  readonly runId: string;
  readonly method: string;
  readonly configVersion: string;
  readonly calculationRunId: string | null;
  readonly periodsUsed: number;
  readonly horizonMonths: number;
  readonly basis: 'strong' | 'limited' | 'weak' | null;
  readonly breakdown: unknown;
  readonly unavailable: unknown;
  readonly generatedAt: string;
  readonly values: ReadonlyArray<{
    readonly periodId: string;
    readonly metricKey: string;
    readonly value: string;
    readonly currency: string | null;
    readonly derivation: string;
    readonly derivedFrom: readonly string[];
  }>;
}

/** The newest forecast for an organisation, with its figures. `null` when none has been made. */
export async function loadLatestForecast(
  db: Db, orgId: string, requestId?: string,
): Promise<StoredForecast | null> {
  void requestId;
  const runs = await readRows(db, orgId, 'forecast_runs', (q) => q.orderBy('generated_at', 'desc').limit(1));
  const run = runs[0];
  if (!run) return null;
  const values = await readRows(db, orgId, 'forecast_values', (q) => q.where('forecast_run_id', '==', run.id));

  const row = { ...run, forecast_values: values } as unknown as {
    id: string; method: string; config_version: string; calculation_run_id: string | null;
    periods_used: number; horizon_months: number; basis: StoredForecast['basis'];
    breakdown: unknown; unavailable: unknown; generated_at: string;
    forecast_values: Array<{
      period_id: string; metric_key: string; value: string; currency: string | null;
      derivation: string; derived_from: string[] | null;
    }> | null;
  };

  return {
    runId: row.id,
    method: row.method,
    configVersion: row.config_version,
    calculationRunId: row.calculation_run_id,
    periodsUsed: row.periods_used,
    horizonMonths: row.horizon_months,
    basis: row.basis,
    breakdown: row.breakdown,
    unavailable: row.unavailable,
    generatedAt: row.generated_at,
    values: (row.forecast_values ?? []).map((v) => ({
      periodId: v.period_id,
      metricKey: v.metric_key,
      /*
       * A `numeric(20,6)` is stored as `10000.000000` (and PostgREST used to hand back `10000`) —
       * the same figure in different shapes, which is how a page ends up rendering a forecast and an
       * actual differently. Money is re-parsed to a Decimal at the data-access boundary and
       * re-emitted in one shape, which is what ADR-006 asks of every reader.
       */
      value: toMoneyString(parseDecimalOrNull(String(v.value)) ?? 0),
      currency: v.currency,
      derivation: v.derivation,
      derivedFrom: v.derived_from ?? [],
    })),
  };
}

/** The evidence bundle a stored forecast run produced, for the "Why?" affordance. */
export async function loadForecastBundleId(
  db: Db, orgId: string, runId: string, requestId?: string,
): Promise<string | null> {
  void requestId;
  const rows = (await readRows(db, orgId, 'evidence_bundles', (q) => q.where('origin_id', '==', runId)))
    .filter((b) => b.origin_table === 'forecast_runs');
  return rows[0] ? String(rows[0].id) : null;
}

/** The newest succeeded calculation run, so a stale forecast can be recognised as stale. */
export async function latestCalculationRunId(
  db: Db, orgId: string, requestId?: string,
): Promise<string | null> {
  void requestId;
  // Equality only, newest picked here: no composite index on (status, created_at).
  const rows = await readRows(db, orgId, 'calculation_runs', (q) => q.where('status', '==', 'succeeded'));
  const newest = rows.sort((a, b) => (String(a.created_at) < String(b.created_at) ? 1 : String(a.created_at) > String(b.created_at) ? -1 : 0))[0];
  return newest ? String(newest.id) : null;
}
