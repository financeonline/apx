import { z } from 'zod';
import {
  CATEGORY_LABELS, loadDimensioned, loadMetricSeries, loadPeriodSnapshots, loadPeriods,
  loadPeriodsWithData, type SnapshotRow,
} from '@/modules/dashboard';
import {
  AVAILABILITY_REASON_TEXT, listAccounts, listCounterparties, metricAvailability,
  type AvailabilityInput,
} from '@/modules/financials';
import {
  isMetricKey, metricDefinition, varianceKey, VARIANCE_SUFFIXES, type VarianceSuffix,
} from '@/modules/financial-engine';
import { loadHealthCard } from '@/modules/health';
import { loadAlerts } from '@/modules/alerts';
import { listActions } from '@/modules/actions';
import { Decimal } from '@/core/money';
import type { PeriodRef } from '../periods';
import { untrusted } from '../untrusted';
import type { NumericValue } from '../values';
import {
  count, fail, money, noData, ok, periodsIn, ratio, resolvePeriodArg, snapshotNumber, subject,
  type Subject,
} from './envelope';
import type { ToolCallContext, ToolDefinition, ToolOutcome } from './types';

/**
 * Tools 1–4 and 14 (AI_ARCHITECTURE.md §3): the metric family, read through `metric_current`.
 *
 * Every figure is a snapshot the engine wrote, read through the pointer the dashboard reads
 * through, and given to the model in the branded envelope with `snapshot_id` beside it — so §7.6
 * can derive the evidence id of the row a number came from and the model can cite nothing else.
 * Nothing here computes: a "change" is the engine's variance snapshot, not a subtraction.
 */

// -----------------------------------------------------------------------------------------------
// Shared shapes
// -----------------------------------------------------------------------------------------------

const DimensionSchema = z.object({
  type: z.enum(['counterparty', 'account', 'standard_category', 'bank_account']),
  id: z.string().min(1),
});

interface MetricValue {
  readonly metric_key: string;
  readonly period: PeriodRef;
  readonly value: NumericValue | null;
  readonly basis: string;
  readonly assurance_level: string;
  /**
   * ADR-106. Whether the figure is economically ESTABLISHED, not merely whether the engine wrote a
   * number. `not_applicable` carries the reason and NO value, so the model has nothing to state as
   * an established conclusion and must report the limitation instead. Present on every metric so
   * the model never has to infer the state from the absence of a field.
   */
  readonly availability:
    | { readonly state: 'available' }
    | { readonly state: 'not_applicable'; readonly reason: string; readonly explanation: string };
  readonly data_quality: { completeness: NumericValue; warnings: readonly string[]; missing: readonly string[] };
  readonly snapshot_id: string;
  readonly subject?: Subject;
}

const qualityOf = (row: SnapshotRow): AvailabilityInput =>
  ({ value: row.value, warnings: row.dataQuality.warnings, missing: row.dataQuality.missing });

/**
 * `costOfSales` is the same period's `cost_of_sales` row where the caller already has it: it holds
 * the accurate reason code. Without it the rule still fires on gross profit's own warning, with the
 * generic reason.
 */
function metricValue(
  row: SnapshotRow,
  period: PeriodRef,
  subj?: Subject,
  costOfSales?: SnapshotRow | null,
): MetricValue {
  const availability = metricAvailability(
    row.metricKey, qualityOf(row), costOfSales ? qualityOf(costOfSales) : null,
  );
  const notApplicable = availability.state === 'not_applicable';
  return {
    metric_key: row.metricKey,
    period,
    // §18: a figure that is not established is not a number the model may quote.
    value: notApplicable ? null : snapshotNumber(row),
    basis: row.basis,
    assurance_level: row.assurance,
    availability: availability.state === 'not_applicable'
      ? {
        state: 'not_applicable',
        reason: availability.reason,
        explanation: AVAILABILITY_REASON_TEXT[availability.reason]
          ?? AVAILABILITY_REASON_TEXT.no_cost_of_sales!,
      }
      : { state: 'available' },
    data_quality: {
      completeness: count(String(row.dataQuality.completeness), 2)!,
      warnings: row.dataQuality.warnings,
      missing: row.dataQuality.missing,
    },
    snapshot_id: row.snapshotId,
    ...(subj ? { subject: subj } : {}),
  };
}

/** The period rows of the organisation, keyed for lookups; one read per call. */
async function periodIndex(call: ToolCallContext): Promise<PeriodIndex> {
  const { ctx } = call;
  const rows = await loadPeriods(ctx.db, ctx.orgId!, ctx.requestId);
  return new Map(rows.map((p) => [p.id, { id: p.id, label: p.label, start: p.periodStart, end: p.periodEnd, complete: p.isComplete }]));
}

/** Names for a dimension row's subject: a counterparty, an account, or a category label. */
async function subjectFor(
  call: ToolCallContext, row: SnapshotRow,
  names: { counterparties: Map<string, string>; accounts: Map<string, string> },
): Promise<Subject | undefined> {
  if (row.dimensionType === 'counterparty' && row.dimensionId) {
    return subject('counterparty', row.dimensionId, names.counterparties.get(row.dimensionId) ?? null);
  }
  if (row.dimensionType === 'account' && row.dimensionId) {
    return subject('account', row.dimensionId, names.accounts.get(row.dimensionId) ?? null);
  }
  if (row.dimensionType === 'standard_category' && row.dimensionKey) {
    // A category is its own id (ADR-053): the label is MOTION's, not imported, but the wrapper
    // is applied uniformly so the walker sees one shape.
    const label = (CATEGORY_LABELS as Readonly<Record<string, string>>)[row.dimensionKey] ?? row.dimensionKey;
    return subject('standard_category', row.dimensionKey, label);
  }
  if (row.dimensionType === 'bank_account' && row.dimensionId) {
    return subject('bank_account', row.dimensionId, names.accounts.get(row.dimensionId) ?? null);
  }
  void call;
  return undefined;
}

async function nameMaps(call: ToolCallContext) {
  const { ctx } = call;
  const [counterparties, accounts] = await Promise.all([
    listCounterparties(ctx.db, ctx.orgId!, { limit: 500, offset: 0 }, ctx.requestId),
    listAccounts(ctx.db, ctx.orgId!, ctx.requestId),
  ]);
  return {
    counterparties: new Map(counterparties.map((c) => [c.id, c.name])),
    accounts: new Map(accounts.map((a) => [a.id, a.name])),
  };
}

interface VarianceValue {
  readonly value: NumericValue | null;
  readonly pct_change: NumericValue | null;
  readonly comparison_period: PeriodRef | null;
  readonly basis_differs: boolean;
  readonly snapshot_id: string;
}

type PeriodIndex = Map<string, PeriodRef & { start: string; end: string; complete: boolean }>;

function varianceValue(row: SnapshotRow, periods: PeriodIndex): VarianceValue {
  const comparisonId = row.components.comparison_period_id;
  const found = typeof comparisonId === 'string' ? periods.get(comparisonId) : undefined;
  const comparison: PeriodRef | null = found ? { id: found.id, label: found.label } : null;
  const pct = row.components.pct_change;
  return {
    value: snapshotNumber(row),
    pct_change: typeof pct === 'string' ? ratio(pct) : null,
    comparison_period: comparison,
    basis_differs: row.dataQuality.warnings.includes('basis_differs'),
    snapshot_id: row.snapshotId,
  };
}

// -----------------------------------------------------------------------------------------------
// 1. get_business_summary
// -----------------------------------------------------------------------------------------------

const HEADLINE = ['revenue', 'gross_profit', 'operating_profit', 'net_profit', 'closing_cash', 'receivables', 'payables'] as const;

export const getBusinessSummary: ToolDefinition<{ period?: string }, unknown> = {
  name: 'get_business_summary',
  description: 'The headline picture for one month: health score, revenue, profit, cash, what is owed, the top alerts and open actions. Use it first for a broad question. `period` must be a label from period_context; omit it for the latest complete month.',
  permission: 'dashboard.view',
  input: z.object({ period: z.string().optional() }),
  async run(input, call) {
    const resolved = resolvePeriodArg(input.period, call);
    if (!resolved.ok) return fail(resolved.error);
    const { ctx } = call;
    const period = resolved.period;
    const [snapshots, periods, alerts, actions] = await Promise.all([
      loadPeriodSnapshots(ctx.db, ctx.orgId!, period.id, ctx.requestId),
      periodIndex(call),
      loadAlerts(ctx.db, ctx.orgId!, { periodId: period.id, statuses: ['open', 'acknowledged'], limit: 3 }, ctx.requestId),
      listActions(ctx, { status: ['open', 'in_progress'] }).catch(() => []),
    ]);
    const byKey = new Map(snapshots.filter((s) => s.dimensionType === 'none').map((s) => [s.metricKey, s]));
    if (byKey.size === 0) return noData('computed figures');

    const here = periods.get(period.id);
    const previous = here
      ? [...periods.values()].filter((p) => p.start < here.start).sort((a, b) => b.start.localeCompare(a.start))[0] ?? null
      : null;
    const health = await loadHealthCard(ctx.db, ctx.orgId!, period.id, previous?.id ?? null, ctx.requestId);

    const costOfSales = byKey.get('cost_of_sales') ?? null;
    const metrics = HEADLINE.flatMap((key) => {
      const row = byKey.get(key);
      return row ? [metricValue(row, period, undefined, costOfSales)] : [];
    });
    const runId = snapshots[0] ? String(snapshots[0].components.calculation_run_id ?? '') || null : null;
    return ok({
      period,
      health: health ? { score: count(health.score, 0), dimensions_used: count(health.dimensionsUsed)!, dimensions_total: count(health.dimensionsTotal)! } : null,
      metrics,
      top_alerts: alerts.map((a) => ({
        id: a.id, revision_no: 0, rule_key: a.ruleKey, severity: a.severity,
        title: untrusted('title', a.title), metric_key: a.metricKey, period,
      })),
      open_actions: count(actions.length)!,
      data_quality: {
        // The lowest completeness over the headline figures, as a Decimal — never a JS number on
        // its way to the model (ADR-006).
        completeness: count(
          metrics.map((m) => new Decimal(m.data_quality.completeness.value))
            .reduce((low, c) => (c.lessThan(low) ? c : low), new Decimal(1)).toString(), 2)!,
        warnings: [...new Set(metrics.flatMap((m) => m.data_quality.warnings))],
      },
    }, { periods: [period], calculation_run_id: runId }, call);
  },
};

// -----------------------------------------------------------------------------------------------
// 2. get_metric
// -----------------------------------------------------------------------------------------------

export const getMetric: ToolDefinition<{ metric_key: string; period?: string; dimension?: { type: string; id: string } }, unknown> = {
  name: 'get_metric',
  description: 'One metric for one month, with its components and its change against the previous month, the same month last year and the trailing three-month average. `period` must be a label from period_context. Pass `dimension` to get the figure for one customer, account, category or bank account.',
  permission: 'financials.view',
  input: z.object({
    metric_key: z.string().min(1),
    period: z.string().optional(),
    dimension: DimensionSchema.optional(),
  }),
  async run(input, call) {
    if (!isMetricKey(input.metric_key)) {
      return fail({ code: 'NOT_FOUND', message: 'That is not a metric MOTION calculates.' });
    }
    const resolved = resolvePeriodArg(input.period, call);
    if (!resolved.ok) return fail(resolved.error);
    const { ctx } = call;
    const period = resolved.period;
    const periods = await periodIndex(call);

    let base: SnapshotRow | undefined;
    let subj: Subject | undefined;
    // The same period's cost of sales, for the availability rule's accurate reason (ADR-106).
    let costOfSales: SnapshotRow | null = null;
    if (input.dimension) {
      const rows = await loadDimensioned(ctx.db, ctx.orgId!, input.metric_key, [period.id], ctx.requestId);
      base = rows.find((r) => (r.dimensionId ?? r.dimensionKey) === input.dimension!.id && r.dimensionType === input.dimension!.type);
      if (base) subj = await subjectFor(call, base, await nameMaps(call));
    } else {
      const rows = await loadPeriodSnapshots(ctx.db, ctx.orgId!, period.id, ctx.requestId);
      base = rows.find((r) => r.metricKey === input.metric_key && r.dimensionType === 'none');
      costOfSales = rows.find((r) => r.metricKey === 'cost_of_sales' && r.dimensionType === 'none') ?? null;
    }
    if (!base) return noData(`${metricDefinition(input.metric_key).label.toLowerCase()} figure`);

    // Variance snapshots are the engine's; the tool never subtracts (§1.1).
    const suffixes = ['prev_period', 'same_period_last_year', 'trailing_3m_avg'] as const satisfies readonly VarianceSuffix[];
    const varianceRows = input.dimension ? [] : await loadMetricSeries(
      ctx.db, ctx.orgId!, suffixes.map((s) => varianceKey(input.metric_key, s)), [period.id], ctx.requestId,
    );
    const variance = Object.fromEntries(suffixes.map((s) => {
      const row = varianceRows.find((r) => r.metricKey === varianceKey(input.metric_key, s));
      return [s, row ? varianceValue(row, periods) : null];
    }));

    const value = metricValue(base, period, subj, costOfSales);
    /*
     * ADR-106: a figure that is not established exposes no components either. Gross profit's
     * components are revenue and cost of sales, and handing the model "revenue 9,000" under a
     * gross-profit result is the same invitation to state it that suppressing the value removed.
     */
    const components = value.availability.state === 'not_applicable' ? [] : Object.entries(base.components)
      .filter(([, v]) => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v))
      .map(([name, v]) => ({ name, value: money(v as string, base!.currency), snapshot_id: base!.snapshotId }));

    const comparisonPeriods = Object.values(variance).flatMap((v) => (v && v.comparison_period ? [v.comparison_period] : []));
    return ok(
      { ...value, components, variance },
      { periods: periodsIn([period, ...comparisonPeriods]), basis: base.basis, assurance_level: base.assurance, calculation_run_id: null },
      call,
    );
  },
};

// -----------------------------------------------------------------------------------------------
// 3. get_metric_trend
// -----------------------------------------------------------------------------------------------

export const getMetricTrend: ToolDefinition<{ metric_key: string; from: string; to: string; dimension?: { type: string; id: string } }, unknown> = {
  name: 'get_metric_trend',
  description: 'One metric across a range of months (at most 24), with the first, last, lowest and highest points and the overall change. `from` and `to` must be labels from period_context or from an earlier result.',
  permission: 'financials.view',
  input: z.object({
    metric_key: z.string().min(1), from: z.string(), to: z.string(), dimension: DimensionSchema.optional(),
  }),
  async run(input, call) {
    if (!isMetricKey(input.metric_key)) return fail({ code: 'NOT_FOUND', message: 'That is not a metric MOTION calculates.' });
    const from = resolvePeriodArg(input.from, call); if (!from.ok) return fail(from.error);
    const to = resolvePeriodArg(input.to, call); if (!to.ok) return fail(to.error);
    const { ctx } = call;
    const periods = await periodIndex(call);
    const a = periods.get(from.period.id)!, b = periods.get(to.period.id)!;
    const [start, end] = a.start <= b.start ? [a.start, b.start] : [b.start, a.start];
    const range = [...periods.values()].filter((p) => p.start >= start && p.start <= end).sort((x, y) => x.start.localeCompare(y.start)).slice(0, 24);
    if (range.length === 0) return noData('months in that range');

    const rows = input.dimension
      ? (await loadDimensioned(ctx.db, ctx.orgId!, input.metric_key, range.map((p) => p.id), ctx.requestId))
          .filter((r) => (r.dimensionId ?? r.dimensionKey) === input.dimension!.id)
      : await loadMetricSeries(ctx.db, ctx.orgId!, [input.metric_key], range.map((p) => p.id), ctx.requestId);
    if (rows.length === 0) return noData(`${metricDefinition(input.metric_key).label.toLowerCase()} figures in that range`);

    const names = input.dimension ? await nameMaps(call) : null;
    const points = [];
    for (const p of range) {
      const row = rows.find((r) => r.periodId === p.id);
      if (!row) continue;
      points.push(metricValue(row, p, names ? await subjectFor(call, row, names) : undefined));
    }
    const valued = points.filter((p) => p.value !== null);
    const decimals = valued.map((p) => new Decimal(p.value!.value));
    const first = valued[0], last = valued[valued.length - 1];
    const min = decimals.length ? decimals.reduce((m, d) => (d.lessThan(m) ? d : m)) : null;
    const max = decimals.length ? decimals.reduce((m, d) => (d.greaterThan(m) ? d : m)) : null;
    const currency = rows[0]!.currency;
    // The overall change is a statement about two engine figures; it is the one arithmetic §1.1
    // permits a tool, because it is a difference of two snapshots the model can also cite.
    const changeAbs = first && last ? new Decimal(last.value!.value).minus(first.value!.value) : null;
    const changeRatio = first && last && !new Decimal(first.value!.value).isZero()
      ? changeAbs!.dividedBy(new Decimal(first.value!.value).abs()) : null;
    return ok({
      points,
      summary: {
        min: min ? money(min.toString(), currency) : null,
        max: max ? money(max.toString(), currency) : null,
        first: first?.value ?? null,
        last: last?.value ?? null,
        change_abs: changeAbs ? money(changeAbs.toString(), currency) : null,
        change_ratio: changeRatio ? ratio(changeRatio.toString()) : null,
      },
    }, { periods: range.map((p) => ({ id: p.id, label: p.label })), calculation_run_id: null }, call);
  },
};

// -----------------------------------------------------------------------------------------------
// 4. get_expense_changes
// -----------------------------------------------------------------------------------------------

export const getExpenseChanges: ToolDefinition<{ period: string; compare_to: VarianceSuffix; by: string; limit?: number }, unknown> = {
  name: 'get_expense_changes',
  description: 'Spending categories or accounts ranked by how much they changed between a month and its comparison. `period` must be a label from period_context.',
  permission: 'financials.view',
  input: z.object({
    period: z.string(),
    compare_to: z.enum(VARIANCE_SUFFIXES),
    by: z.enum(['standard_category', 'account']),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async run(input, call) {
    const resolved = resolvePeriodArg(input.period, call); if (!resolved.ok) return fail(resolved.error);
    const { ctx } = call;
    const period = resolved.period;
    const base = input.by === 'standard_category' ? 'expense_by_category' : 'expense_by_account';
    const periods = await periodIndex(call);
    const [current, variances, names] = await Promise.all([
      loadDimensioned(ctx.db, ctx.orgId!, base, [period.id], ctx.requestId),
      loadDimensioned(ctx.db, ctx.orgId!, varianceKey(base, input.compare_to), [period.id], ctx.requestId),
      nameMaps(call),
    ]);
    if (current.length === 0) return noData('spending breakdown');

    const rows = [];
    for (const row of current) {
      const key = row.dimensionId ?? row.dimensionKey;
      const variance = variances.find((v) => (v.dimensionId ?? v.dimensionKey) === key);
      const change = variance ? varianceValue(variance, periods) : null;
      const previousValue = change && change.value && row.value !== null
        ? new Decimal(row.value).minus(change.value.value).toString() : null;
      rows.push({
        subject: await subjectFor(call, row, names),
        current: money(row.value, row.currency),
        previous: money(previousValue, row.currency),
        change_abs: change?.value ?? null,
        change_ratio: change?.pct_change ?? null,
        basis_differs: change?.basis_differs ?? false,
        snapshot_id: row.snapshotId,
        change_snapshot_id: change?.snapshot_id ?? null,
      });
    }
    rows.sort((a, b) => new Decimal(b.change_abs?.value ?? 0).abs().comparedTo(new Decimal(a.change_abs?.value ?? 0).abs()));
    const comparison = rows.map(() => variances[0]).filter(Boolean)[0];
    const comparisonPeriod = comparison ? varianceValue(comparison, periods).comparison_period : null;
    return ok({ rows: rows.slice(0, input.limit ?? 10) },
      { periods: periodsIn([period, comparisonPeriod]), calculation_run_id: null }, call);
  },
};

// -----------------------------------------------------------------------------------------------
// 14. get_data_coverage
// -----------------------------------------------------------------------------------------------

export const getDataCoverage: ToolDefinition<{ from?: string; to?: string }, unknown> = {
  name: 'get_data_coverage',
  description: 'Which months have data, which are complete, and which sources each month rests on. Use it before answering about a month you are not sure exists, and cite it when there is no data.',
  permission: 'dashboard.view',
  input: z.object({ from: z.string().optional(), to: z.string().optional() }),
  async run(input, call) {
    const { ctx } = call;
    const [periods, withData] = await Promise.all([
      periodIndex(call), loadPeriodsWithData(ctx.db, ctx.orgId!, ctx.requestId),
    ]);
    let list = [...periods.values()].sort((a, b) => a.start.localeCompare(b.start));
    if (input.from) { const r = resolvePeriodArg(input.from, call); if (!r.ok) return fail(r.error); list = list.filter((p) => p.start >= periods.get(r.period.id)!.start); }
    if (input.to) { const r = resolvePeriodArg(input.to, call); if (!r.ok) return fail(r.error); list = list.filter((p) => p.start <= periods.get(r.period.id)!.start); }

    const snapshots = await loadMetricSeries(ctx.db, ctx.orgId!, ['revenue', 'closing_cash', 'receivables'], list.map((p) => p.id), ctx.requestId);
    const months = list.map((p) => {
      const mine = snapshots.filter((s) => s.periodId === p.id);
      const basisOf = (k: string) => mine.find((s) => s.metricKey === k)?.basis ?? 'none';
      const completeness = mine.length ? Math.min(...mine.map((s) => s.dataQuality.completeness)) : 0;
      return {
        period: { id: p.id, label: p.label },
        is_complete: p.complete,
        has_data: withData.has(p.id),
        basis_pnl: basisOf('revenue'),
        basis_cash: basisOf('closing_cash'),
        completeness: count(String(completeness), 2)!,
      };
    });
    return ok({ months, latest_complete: call.periodContext.latestComplete },
      { periods: months.map((m) => m.period), calculation_run_id: null }, call);
  },
};

export type { ToolOutcome };
