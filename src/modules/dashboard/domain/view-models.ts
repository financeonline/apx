/**
 * The view models Home and the Money pages render (UX_ARCHITECTURE.md §4, §5).
 *
 * Components never compute a number and never format one: services return finished view models and
 * components render them (`SERVICE_ARCHITECTURE.md §8`; the `no-arithmetic-in-components` lint rule
 * fails the build otherwise). A view model therefore carries the FORMATTED string a card shows,
 * alongside the raw value for tests and for the evidence link.
 *
 * Pure types plus the mapping from a snapshot to a card. No I/O.
 */

import { Decimal, formatChange, formatMoney, formatPercent, isPositive, parseDecimalOrNull } from '@/core/money';
import type { AssuranceLevel, DataQuality, MetricBasis } from '@/modules/financial-engine';
import { BASIS_TEXT, labelFor } from '@/modules/financials';
import { statusFor, type StatusBadge } from './status';

/** One metric as read from `metric_current` joined to its snapshot. */
export interface SnapshotRow {
  readonly snapshotId: string;
  readonly metricKey: string;
  readonly periodId: string;
  readonly dimensionType: string;
  readonly dimensionId: string | null;
  /** The category name, for the one dimension that is not a row (ADR-053). Null otherwise. */
  readonly dimensionKey?: string | null;
  readonly value: string | null;
  readonly unit: 'money' | 'ratio' | 'count' | 'days';
  readonly currency: string | null;
  readonly basis: MetricBasis;
  readonly assurance: AssuranceLevel;
  readonly dataQuality: DataQuality;
  readonly components: Readonly<Record<string, unknown>>;
}

export interface PeriodLabel {
  readonly id: string;
  readonly label: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly isComplete: boolean;
}

export interface ChangeView {
  /** "+£2,100 (+8.3%) vs February" — the whole line, formatted once by core/money (§8.2). */
  readonly text: string;
  /** "+£2,100" on its own, for a compact card. */
  readonly amount: string;
  /** "+8.3%", or null when a percentage would be meaningless (§3.2). */
  readonly percent: string | null;
  /**
   * Whether the movement is good news. Metric-aware: a fall in expenses is favourable, a fall in
   * revenue is not (§4). Null when the direction carries no meaning.
   */
  readonly favourable: boolean | null;
  /** ADR-030: a variance across two different bases is shown, but never as a percentage. */
  readonly basisDiffers: boolean;
  readonly comparisonLabel: string;
}

export interface MetricCardView {
  readonly metricKey: string;
  /** The plain phrase a business owner reads (§8.1). */
  readonly label: string;
  /** The accountant's term, for the tooltip. */
  readonly technicalLabel: string;
  /** "£12,400", or "—" when not computable — never "0" and never blank (§4). */
  readonly value: string;
  readonly rawValue: string | null;
  readonly secondaryLine: { readonly label: string; readonly value: string } | null;
  readonly change: ChangeView | null;
  readonly status: StatusBadge;
  readonly basisText: string;
  readonly period: PeriodLabel;
  /** Opens the evidence drawer for this metric and period (§4). */
  readonly whyHref: string;
}

/**
 * Which direction is good news, per metric (§4).
 *
 * Absent from this map means the direction carries no inherent meaning — working capital can move
 * either way for good reasons — and the card shows the change without a colour.
 */
const FAVOURABLE_WHEN_RISING: Readonly<Record<string, boolean>> = {
  revenue: true,
  gross_profit: true,
  gross_margin: true,
  operating_profit: true,
  operating_margin: true,
  net_profit: true,
  net_margin: true,
  closing_cash: true,
  net_cash_movement: true,
  cash_inflows: true,
  contribution_margin: true,
  cash_runway_months: true,
  // A rise in what you are owed ties up cash; a rise in what you owe is not good news either.
  receivables: false,
  receivables_overdue: false,
  receivables_days: false,
  payables_overdue: false,
  payables_days: false,
  operating_expenses: false,
  cost_of_sales: false,
  cash_outflows: false,
  expense_by_category: false,
  expense_by_account: false,
};


/**
 * Formats a value for display, by unit. Never returns "0" for an absent figure (§4).
 *
 * `showMinorUnits` is §8.2's rule: pence appear on Money sub-pages, in evidence and in reports,
 * where an accountant may be reconciling to the penny, and are rounded away on headline cards,
 * where 50p next to twelve thousand pounds is noise.
 */
/** Re-exported, not restated: the canonical §8.1 table lives in `modules/financials` (ADR-037). */
export { BASIS_TEXT, METRIC_LABELS, labelFor } from '@/modules/financials';

export function formatValue(
  row: Pick<SnapshotRow, 'value' | 'unit' | 'currency'>,
  options: { readonly showMinorUnits?: boolean } = {},
): string {
  if (row.value === null) return '—';
  switch (row.unit) {
    case 'money':
      return formatMoney(row.value, {
        currency: row.currency ?? 'GBP', showMinorUnits: options.showMinorUnits,
      });
    case 'ratio':
      return formatPercent(row.value);
    case 'days': {
      const days = parseDecimalOrNull(row.value);
      return days === null ? '—' : `${days.toDecimalPlaces(0).toString()} days`;
    }
    case 'count': {
      const count = parseDecimalOrNull(row.value);
      if (count === null) return '—';
      // The runway cap (§3.3): beyond three years the exact figure is noise, and a precise "41.7
      // months" would invite a confidence the underlying average does not support.
      return count.greaterThan(new Decimal(36)) ? '36+' : count.toFixed(1);
    }
  }
}

export interface VarianceRow {
  readonly value: string | null;
  readonly components: Readonly<Record<string, unknown>>;
  readonly dataQuality: DataQuality;
}

/**
 * Builds the change line from a variance snapshot.
 *
 * Returns null when there is nothing honest to say: no comparison exists, or the comparison was
 * zero, in which case §3.2 writes the absolute change but no percentage.
 */
export function changeFrom(
  base: SnapshotRow,
  variance: VarianceRow | null,
  comparisonLabel: string,
  options: { readonly showMinorUnits?: boolean } = {},
): ChangeView | null {
  if (!variance || variance.value === null) return null;

  const basisDiffers = variance.dataQuality.warnings.includes('basis_differs');
  const pct = variance.components.pct_change;
  const rising = isPositive(variance.value);
  const favourableWhenRising = FAVOURABLE_WHEN_RISING[base.metricKey];

  // ADR-030: a variance across two bases is shown, but never as a percentage — the number would
  // compare two different things, and the card says "compared on a different basis" instead.
  const percentInput = basisDiffers || pct === null || pct === undefined ? null : String(pct);
  const currency = base.currency ?? 'GBP';
  const favourable = favourableWhenRising === undefined ? null : rising === favourableWhenRising;

  // The change is in the figure's own unit (client pass, ADR-176): a margin moves in percentage
  // points and a collection period in days, never in pounds ("+£0.00 (−0.4%)" read as nonsense).
  if (base.unit !== 'money') {
    const amount = unitChange(variance.value, base.unit);
    return {
      text: `${amount} vs ${comparisonLabel}`,
      amount,
      percent: null,
      favourable,
      basisDiffers,
      comparisonLabel,
    };
  }

  return {
    text: `${formatChange(variance.value, percentInput, { currency, showMinorUnits: options.showMinorUnits })} vs ${comparisonLabel}`,
    amount: formatMoney(variance.value, {
      currency, signDisplay: 'always', showMinorUnits: options.showMinorUnits,
    }),
    percent: percentInput === null
      ? null
      : formatPercent(percentInput, { signDisplay: 'always' }),
    favourable,
    basisDiffers,
    comparisonLabel,
  };
}

/** "+0.4 points", "−3 days", "+1.5": a movement in a figure that is not money. */
function unitChange(value: string, unit: 'ratio' | 'count' | 'days'): string {
  const parsed = parseDecimalOrNull(value);
  if (parsed === null) return '—';
  const sign = parsed.isZero() ? '' : parsed.isNegative() ? '−' : '+';
  const size = parsed.abs();
  if (unit === 'ratio') {
    const points = size.times(100).toDecimalPlaces(1);
    return points.isZero() ? 'no change' : `${sign}${points.toString()} ${points.equals(1) ? 'point' : 'points'}`;
  }
  if (unit === 'days') {
    const days = size.toDecimalPlaces(0);
    return days.isZero() ? 'no change' : `${sign}${days.toString()} ${days.equals(1) ? 'day' : 'days'}`;
  }
  const count = size.toDecimalPlaces(1);
  return count.isZero() ? 'no change' : `${sign}${count.toString()}`;
}

export interface CardOptions {
  readonly orgSlug: string;
  readonly comparisonLabel: string;
  readonly secondary?: { readonly label: string; readonly row: SnapshotRow | null };
  /** §8.2: pence on Money sub-pages, evidence and reports; rounded on headline cards. */
  readonly showMinorUnits?: boolean;
}

/**
 * The "Why?" link of one figure (§4): the metric, the month and — for a figure broken down by an
 * account, a customer or a standard category — WHICH row of the breakdown. Without the dimension the
 * evidence page looks for the undimensioned figure, which a breakdown-only metric
 * (`expense_by_category`, `expense_by_account`, …) does not have, and the link opens a 404.
 * Scalars keep the plain `?metric=&period=` form.
 */
export function evidenceHref(
  orgSlug: string,
  cell: Pick<SnapshotRow, 'metricKey' | 'periodId' | 'dimensionType' | 'dimensionId' | 'dimensionKey'>,
  periodId: string = cell.periodId,
): string {
  const query = new URLSearchParams({ metric: cell.metricKey, period: periodId });
  if (cell.dimensionType && cell.dimensionType !== 'none') {
    query.set('dim', cell.dimensionType);
    if (cell.dimensionId) query.set('dimension', cell.dimensionId);
    if (cell.dimensionKey) query.set('key', cell.dimensionKey);
  }
  return `/app/${orgSlug}/evidence?${query.toString()}`;
}

export function toMetricCard(
  row: SnapshotRow,
  period: PeriodLabel,
  variance: VarianceRow | null,
  options: CardOptions,
): MetricCardView {
  const labels = labelFor(row.metricKey);

  return {
    metricKey: row.metricKey,
    label: labels.plain,
    technicalLabel: labels.technical,
    value: formatValue(row, { showMinorUnits: options.showMinorUnits }),
    rawValue: row.value,
    secondaryLine: options.secondary && options.secondary.row
      ? {
          label: options.secondary.label,
          value: formatValue(options.secondary.row, { showMinorUnits: options.showMinorUnits }),
        }
      : null,
    change: changeFrom(row, variance, options.comparisonLabel, {
      showMinorUnits: options.showMinorUnits,
    }),
    status: statusFor(row),
    basisText: BASIS_TEXT[row.basis] ?? '',
    period,
    // The "Why?" affordance every number carries (§4).
    whyHref: evidenceHref(options.orgSlug, row, period.id),
  };
}
