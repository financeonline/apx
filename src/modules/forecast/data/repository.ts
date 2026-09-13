import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
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
 * Every read runs on the caller's own client, so RLS decides. The organisation is an argument the
 * service takes from the request's AccessContext, never from anything a browser sent.
 */

export interface HistoryRow extends ActualPoint {
  readonly metricKey: string;
  /** The snapshot behind the figure, which is what the forecast's evidence cites. */
  readonly snapshotId: string;
  readonly currency: string | null;
  readonly calculationRunId: string | null;
}

interface CurrentRow {
  metric_key: string;
  period_id: string;
  snapshot_id: string;
  metric_snapshots: {
    id: string; value: string | null; currency: string | null;
    assurance_level: AssuranceLevel | null;
    data_quality: { warnings?: string[] } | null;
    calculation_run_id: string | null;
  } | null;
  fiscal_periods: { period_start: string; label: string; is_complete: boolean } | null;
}

const SELECT = `
  metric_key, period_id, snapshot_id,
  metric_snapshots!inner ( id, value, currency, assurance_level, data_quality, calculation_run_id ),
  fiscal_periods!inner ( period_start, label, is_complete )`;

/**
 * The history for a set of metrics, oldest first.
 *
 * `dimension_type = 'none'` because a forecast is about the business, not about one account or one
 * customer. Only periods on or before `upTo` are read: a forecast must not learn from a period it
 * is about to forecast, and the current part-month is excluded by the completeness rule anyway.
 */
export async function loadHistory(
  db: SupabaseClient,
  orgId: string,
  metricKeys: readonly string[],
  upTo: string,
  requestId?: string,
): Promise<HistoryRow[]> {
  const { data, error } = await db
    .from('metric_current')
    .select(SELECT)
    .eq('organization_id', orgId)
    .eq('dimension_type', 'none')
    .in('metric_key', [...metricKeys])
    .lte('fiscal_periods.period_start', upTo)
    .order('period_id', { ascending: true });
  if (error) throw toMotionError(error, requestId);

  const rows = (data ?? []) as unknown as CurrentRow[];
  return rows.flatMap((row) => {
    const snapshot = row.metric_snapshots;
    const period = row.fiscal_periods;
    if (!snapshot || !period) return [];
    return [{
      metricKey: row.metric_key,
      snapshotId: snapshot.id,
      periodId: row.period_id,
      periodStart: period.period_start,
      periodLabel: period.label,
      value: snapshot.value === null ? null : String(snapshot.value),
      isComplete: period.is_complete,
      assurance: snapshot.assurance_level,
      warnings: snapshot.data_quality?.warnings ?? [],
      currency: snapshot.currency,
      calculationRunId: snapshot.calculation_run_id,
    }];
  });
}

/** The months a forecast will speak about: real period rows strictly after the last actual one. */
export async function loadHorizon(
  db: SupabaseClient, orgId: string, after: string, months: number, requestId?: string,
): Promise<HorizonPeriod[]> {
  const { data, error } = await db
    .from('fiscal_periods')
    .select('id, period_start, label')
    .eq('organization_id', orgId)
    .gt('period_start', after)
    .order('period_start', { ascending: true })
    .limit(months);
  if (error) throw toMotionError(error, requestId);

  return ((data ?? []) as Array<{ id: string; period_start: string; label: string }>)
    .map((row) => ({ periodId: row.id, periodStart: row.period_start, periodLabel: row.label }));
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
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<StoredForecast | null> {
  const { data, error } = await db
    .from('forecast_runs')
    .select(`id, method, config_version, calculation_run_id, periods_used, horizon_months,
             basis, breakdown, unavailable, generated_at,
             forecast_values ( period_id, metric_key, value, currency, derivation, derived_from )`)
    .eq('organization_id', orgId)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw toMotionError(error, requestId);
  if (!data) return null;

  const row = data as unknown as {
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
       * PostgREST hands a `numeric` back as a JSON number, so `String()` alone would turn the
       * `10000.00` the engine wrote into `10000` — the same figure in a different shape, which is
       * how a page ends up rendering a forecast and an actual differently. Money is re-parsed to a
       * Decimal at the data-access boundary and re-emitted in one shape, which is what ADR-006 asks
       * of every reader.
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
  db: SupabaseClient, orgId: string, runId: string, requestId?: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('evidence_bundles').select('id')
    .eq('organization_id', orgId).eq('origin_table', 'forecast_runs').eq('origin_id', runId)
    .maybeSingle();
  if (error) throw toMotionError(error, requestId);
  return (data as { id?: string } | null)?.id ?? null;
}

/** The newest succeeded calculation run, so a stale forecast can be recognised as stale. */
export async function latestCalculationRunId(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('calculation_runs').select('id')
    .eq('organization_id', orgId).eq('status', 'succeeded')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw toMotionError(error, requestId);
  return (data as { id?: string } | null)?.id ?? null;
}
