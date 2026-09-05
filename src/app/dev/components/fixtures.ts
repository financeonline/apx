import {
  toMetricCard,
  type MetricCardView,
  type PeriodLabel,
  type SnapshotRow,
  type VarianceRow,
} from '@/modules/dashboard';
import type { DataQualityWarning } from '@/modules/financial-engine';
import type { TrendSeriesView } from '@/components/dashboard';

/**
 * Fixed data for the component fixture page.
 *
 * The cards are built with the real `toMetricCard`, not hand-written view models, so what the page
 * shows is what Home will show — including the badge each figure earns. A fixture that invented its
 * own view models would be a picture of a product rather than a rehearsal of one.
 */

const MARCH: PeriodLabel = {
  id: '2026-03',
  label: 'March 2026',
  periodStart: '2026-03-01',
  periodEnd: '2026-03-31',
  isComplete: true,
};

const PERFECT = { completeness: 1, proxy: false, warnings: [], missing: [] } as const;

function snapshot(over: Partial<SnapshotRow> & { metricKey: string }): SnapshotRow {
  return {
    snapshotId: `snap-${over.metricKey}`,
    periodId: MARCH.id,
    dimensionType: 'none',
    dimensionId: null,
    value: '0',
    unit: 'money',
    currency: 'GBP',
    basis: 'ledger',
    assurance: 'verified',
    dataQuality: PERFECT,
    components: {},
    ...over,
  };
}

function variance(
  value: string,
  pct: string | null,
  warnings: readonly DataQualityWarning[] = [],
): VarianceRow {
  return {
    value,
    components: { pct_change: pct },
    dataQuality: { ...PERFECT, warnings },
  };
}

const OPTIONS = { orgSlug: 'acme-ltd', comparisonLabel: 'February' } as const;

export const CARDS: readonly MetricCardView[] = [
  // Verified and complete: the ordinary case, which carries no badge at all (§8.1).
  toMetricCard(
    snapshot({ metricKey: 'revenue', value: '45200' }),
    MARCH,
    variance('2100', '0.0488'),
    OPTIONS,
  ),
  // Operating profit carries net profit on a visible second line, never a tooltip (§4).
  toMetricCard(
    snapshot({ metricKey: 'operating_profit', value: '8400', assurance: 'calculated' }),
    MARCH,
    variance('-1300', '-0.1341'),
    { ...OPTIONS, secondary: { label: 'Profit after interest and tax', row: snapshot({ metricKey: 'net_profit', value: '6100', assurance: 'calculated' }) } },
  ),
  // Incomplete data outranks a firm assurance level: "Partial data" (§8.1).
  toMetricCard(
    snapshot({
      metricKey: 'closing_cash',
      value: '18400',
      basis: 'bank',
      dataQuality: { completeness: 0.72, proxy: false, warnings: ['bank_coverage_partial'], missing: [] },
    }),
    MARCH,
    variance('4200', '0.2958'),
    OPTIONS,
  ),
  // A rise in what you are owed ties up cash, so the movement is unfavourable (§4).
  toMetricCard(
    snapshot({ metricKey: 'receivables', value: '12750', basis: 'invoices', assurance: 'estimated' }),
    MARCH,
    variance('1900', '0.1751'),
    OPTIONS,
  ),
  // AI-read rows: "Please check" until someone confirms them.
  toMetricCard(
    snapshot({ metricKey: 'payables', value: '7300', basis: 'invoices', assurance: 'inferred' }),
    MARCH,
    variance('-800', '-0.0988'),
    OPTIONS,
  ),
  // ADR-030: the two months were measured from different sources, so no percentage is shown and
  // the amount is greyed.
  toMetricCard(
    snapshot({ metricKey: 'net_cash_movement', value: '4200', basis: 'mixed' }),
    MARCH,
    variance('900', '0.2727', ['basis_differs']),
    OPTIONS,
  ),
  // Not computable: an em dash and a reason, never a zero and never a blank (§4). No comparison
  // either, so the change line says so in words.
  toMetricCard(
    snapshot({
      metricKey: 'working_capital',
      value: null,
      dataQuality: { completeness: 0, proxy: false, warnings: [], missing: ['no_prior_trial_balance'] },
    }),
    MARCH,
    null,
    OPTIONS,
  ),
];

export const DEV_PERIODS = [
  { id: '2026-04', label: 'April 2026', isComplete: false },
  { id: '2026-03', label: 'March 2026', isComplete: true },
  { id: '2026-02', label: 'February 2026', isComplete: true },
  { id: '2026-01', label: 'January 2026', isComplete: true },
  { id: '2025-11', label: 'November 2025', isComplete: true },
] as const;

/** Twelve months, with December missing from every series so the gap is visible (§4). */
const MONTHS: ReadonlyArray<{ id: string; label: string }> = [
  { id: '2025-04', label: 'April 2025' },
  { id: '2025-05', label: 'May 2025' },
  { id: '2025-06', label: 'June 2025' },
  { id: '2025-07', label: 'July 2025' },
  { id: '2025-08', label: 'August 2025' },
  { id: '2025-09', label: 'September 2025' },
  { id: '2025-10', label: 'October 2025' },
  { id: '2025-11', label: 'November 2025' },
  { id: '2025-12', label: 'December 2025' },
  { id: '2026-01', label: 'January 2026' },
  { id: '2026-02', label: 'February 2026' },
  { id: '2026-03', label: 'March 2026' },
];

function series(
  key: string,
  label: string,
  values: ReadonlyArray<number | null>,
  displays: readonly string[],
): TrendSeriesView {
  return {
    key,
    label,
    points: MONTHS.map((month, index) => ({
      periodId: month.id,
      periodLabel: month.label,
      value: values[index] ?? null,
      display: displays[index] ?? '—',
    })),
  };
}

export const TREND_SERIES: readonly TrendSeriesView[] = [
  series(
    'revenue',
    'Sales',
    [38000, 39500, 41200, 40100, 42800, 44100, 43200, 45900, null, 44200, 43100, 45200],
    ['£38,000', '£39,500', '£41,200', '£40,100', '£42,800', '£44,100', '£43,200', '£45,900', '—', '£44,200', '£43,100', '£45,200'],
  ),
  series(
    'operating_profit',
    'Profit',
    [5200, 6100, 7400, 5900, 8200, 9100, 7800, 10200, null, 9400, 9700, 8400],
    ['£5,200', '£6,100', '£7,400', '£5,900', '£8,200', '£9,100', '£7,800', '£10,200', '—', '£9,400', '£9,700', '£8,400'],
  ),
  series(
    'closing_cash',
    'Cash',
    [11200, 12800, 14100, 13200, 15900, 17400, 16100, 19200, null, 17800, 14200, 18400],
    ['£11,200', '£12,800', '£14,100', '£13,200', '£15,900', '£17,400', '£16,100', '£19,200', '—', '£17,800', '£14,200', '£18,400'],
  ),
];

/** §11: the trend in words, written by the service, never derived inside the chart. */
export const TREND_ARIA_SUMMARY = [
  'Sales rose from £38,000 in April 2025 to £45,200 in March 2026,',
  'profit from £5,200 to £8,400, and cash from £11,200 to £18,400.',
  'December 2025 has no figures.',
].join(' ');
