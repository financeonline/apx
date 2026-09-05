import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { varianceKey } from '@/modules/financial-engine';
import * as repo from '../data/repository';
import {
  changeFrom, formatValue, labelFor, toMetricCard,
  type MetricCardView, type PeriodLabel, type SnapshotRow,
} from '../domain/view-models';
import { BASIS_TEXT } from '../domain/status';

/**
 * Home (UX_ARCHITECTURE.md §4).
 *
 * Assembles the view models the page renders. It reads snapshots and formats them; it never
 * computes a financial figure — every number on Home is a figure the engine already wrote, read
 * through the `metric_current` pointer. That is what makes the integration assertion possible:
 * every figure on the page must equal its snapshot.
 */

/** §4: Home opens on the LATEST COMPLETE month, the same rule the analyst uses. */
export function latestCompletePeriod(periods: readonly PeriodLabel[]): PeriodLabel | null {
  return periods.find((p) => p.isComplete) ?? null;
}

/**
 * The partial current month, shown as one slim line under the heading (§4).
 *
 * A month that is not finished gets no health score, no comparisons and no alerts, because a
 * part-month compared with a whole one is a misleading comparison rather than a useful one.
 */
export function partialPeriod(
  periods: readonly PeriodLabel[], withData: ReadonlySet<string>,
): PeriodLabel | null {
  const complete = latestCompletePeriod(periods);
  const candidate = periods.find((p) => !p.isComplete && withData.has(p.id));
  if (!candidate) return null;
  if (complete && candidate.periodStart <= complete.periodStart) return null;
  return candidate;
}

export type HomeState =
  /** No committed data at all (§6 "Home, first run"). */
  | { readonly kind: 'first_run' }
  /** Data uploaded but still awaiting review (§6). */
  | { readonly kind: 'awaiting_review'; readonly batchId: string; readonly filename: string; readonly rowCount: number; readonly issueCount: number }
  /** Bank data only: three cards plus the opening-balance prompt (§4, ADR-035). */
  | { readonly kind: 'bank_only'; readonly view: HomeView }
  | { readonly kind: 'ready'; readonly view: HomeView };

export interface PartialMonthLine {
  readonly label: string;
  /** "money in £6,000 · money out £4,100" — already formatted. */
  readonly summary: string;
  readonly href: string;
}

export interface HomeView {
  readonly period: PeriodLabel;
  readonly periods: readonly PeriodLabel[];
  readonly cards: readonly MetricCardView[];
  /** "Based on your bank statements · Last data added 12 Mar 2026 · March 2026". */
  readonly basisLine: string;
  readonly partialMonth: PartialMonthLine | null;
  readonly recalculating: boolean;
  /** True when no cost-of-sales account exists, so the gross-profit card is omitted (CD-05). */
  readonly hidesGrossProfit: boolean;
}

/** The Level 2 cards, in the order §4 fixes. Order is part of the contract, not a preference. */
const HEADLINE_ORDER = [
  'revenue', 'gross_profit', 'operating_profit', 'closing_cash', 'receivables', 'payables',
] as const;

/** The bank-only variant's three cards plus cash (§4, ADR-035). */
const BANK_ONLY_ORDER = ['cash_inflows', 'cash_outflows', 'net_cash_movement', 'closing_cash'] as const;

function index(rows: readonly SnapshotRow[]): Map<string, SnapshotRow> {
  const map = new Map<string, SnapshotRow>();
  for (const row of rows) {
    if (row.dimensionType === 'none') map.set(row.metricKey, row);
  }
  return map;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The basis and freshness line (§4 level 1). */
function basisLine(cards: readonly MetricCardView[], lastData: string | null, period: PeriodLabel): string {
  const sources = [...new Set(cards.map((c) => c.basisText).filter(Boolean))];
  const parts: string[] = [];
  if (sources.length > 0) parts.push(`Based on ${sources.join(' and ').toLowerCase()}`);
  const added = formatDate(lastData);
  if (added) parts.push(`Last data added ${added}`);
  parts.push(`${period.label} (latest complete month)`);
  return parts.join(' · ');
}

export async function loadHome(
  db: SupabaseClient,
  orgId: string,
  orgSlug: string,
  requestId?: string,
): Promise<HomeState> {
  const [periods, withData, recalculating, lastData] = await Promise.all([
    repo.loadPeriods(db, orgId, requestId),
    repo.loadPeriodsWithData(db, orgId, requestId),
    repo.isRecalculating(db, orgId, requestId),
    repo.loadLastDataDate(db, orgId, requestId),
  ]);

  if (withData.size === 0) {
    // Nothing computed yet — but "you have not added anything" and "you added something and it is
    // waiting for you" need completely different sentences (§6).
    const pending = await repo.loadPendingBatch(db, orgId, requestId);
    if (pending) {
      return {
        kind: 'awaiting_review',
        batchId: pending.id,
        filename: pending.filename,
        rowCount: pending.rowCount,
        issueCount: pending.issueCount,
      };
    }
    return { kind: 'first_run' };
  }

  const period = latestCompletePeriod(periods.filter((p) => withData.has(p.id)))
    // No complete month yet: fall back to the latest month that has data, and let the partial line
    // carry the caveat (§4, core/periods.latestCompletePeriod).
    ?? periods.find((p) => withData.has(p.id))
    ?? null;

  if (!period) return { kind: 'first_run' };

  const previous = periods
    .filter((p) => p.periodStart < period.periodStart && withData.has(p.id))[0] ?? null;

  const snapshots = await repo.loadPeriodSnapshots(db, orgId, period.id, requestId);
  const byKey = index(snapshots);

  // CD-05: an organisation with no direct-cost accounts never sees a gross-profit card, because
  // "profit after direct costs" equal to sales would read as a 100% margin.
  const grossProfit = byKey.get('gross_profit');
  const hidesGrossProfit = !grossProfit
    || grossProfit.dataQuality.missing.includes('no_cost_of_sales_accounts');

  // The bank-only variant (ADR-035): the organisation has bank data and NO P&L source at all.
  //
  // The test is deliberately about the organisation rather than the month: a business whose March
  // ledger simply has not been uploaded yet should still see its ordinary Home with the missing
  // figures dashed, not be told it is a bank-only business. So the variant needs cash figures
  // present AND revenue either absent or explicitly uncovered.
  const revenue = byKey.get('revenue');
  const hasCash = byKey.has('cash_inflows') || byKey.has('cash_outflows');
  const noPnlSource = !revenue || (revenue.value === null && revenue.basis === 'none');
  const bankOnly = hasCash && noPnlSource;

  const order = bankOnly
    ? BANK_ONLY_ORDER
    : HEADLINE_ORDER.filter((key) => key !== 'gross_profit' || !hidesGrossProfit);

  const cards: MetricCardView[] = [];
  for (const key of order) {
    const row = byKey.get(key);
    if (!row) continue;

    const variance = byKey.get(varianceKey(key, 'prev_period')) ?? null;

    cards.push(toMetricCard(row, period, variance, {
      orgSlug,
      comparisonLabel: previous?.label ?? 'the previous month',
      // §4: operating profit carries net profit on a visible second line, never a tooltip.
      secondary: key === 'operating_profit'
        ? { label: labelFor('net_profit').plain, row: byKey.get('net_profit') ?? null }
        : undefined,
    }));
  }

  const partial = partialPeriod(periods, withData);
  let partialLine: PartialMonthLine | null = null;
  if (partial) {
    const partialSnapshots = await repo.loadPeriodSnapshots(db, orgId, partial.id, requestId);
    const partialByKey = index(partialSnapshots);
    const inflow = partialByKey.get('cash_inflows');
    const outflow = partialByKey.get('cash_outflows');
    if (inflow || outflow) {
      partialLine = {
        label: `${partial.label} so far`,
        summary: [
          inflow ? `money in ${formatValue(inflow)}` : null,
          outflow ? `money out ${formatValue(outflow)}` : null,
        ].filter(Boolean).join(' · '),
        href: `/app/${orgSlug}/money/cash?period=${partial.id}`,
      };
    }
  }

  const view: HomeView = {
    period,
    periods: periods.filter((p) => withData.has(p.id)),
    cards,
    basisLine: basisLine(cards, lastData, period),
    partialMonth: partialLine,
    recalculating,
    hidesGrossProfit,
  };

  return bankOnly ? { kind: 'bank_only', view } : { kind: 'ready', view };
}

/** The trend chart's three series (§4 level 3). */
export interface TrendSeries {
  readonly key: string;
  readonly label: string;
  readonly points: ReadonlyArray<{ period: string; label: string; value: string | null }>;
}

export async function loadTrend(
  db: SupabaseClient,
  orgId: string,
  periods: readonly PeriodLabel[],
  requestId?: string,
): Promise<TrendSeries[]> {
  const window = [...periods].slice(0, 12).reverse();
  const keys = ['revenue', 'operating_profit', 'closing_cash'];
  const rows = await repo.loadMetricSeries(db, orgId, keys, window.map((p) => p.id), requestId);

  const byKeyPeriod = new Map(rows.map((r) => [`${r.metricKey}|${r.periodId}`, r]));

  return keys.map((key) => ({
    key,
    label: labelFor(key).plain,
    points: window.map((p) => ({
      period: p.id,
      label: p.label,
      // A month with no figure is a gap in the line, not a zero (§4).
      value: byKeyPeriod.get(`${key}|${p.id}`)?.value ?? null,
    })),
  }));
}

export { BASIS_TEXT, changeFrom };
