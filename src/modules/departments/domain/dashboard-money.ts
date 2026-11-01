/**
 * Pure helpers for the money departments of the department dashboard (ADR-180) — Financial
 * Analysis and Banking — and for the month window every department shares. They turn the engine's
 * monthly figures (decimal strings) into the contract's metrics, chart, mix and queue
 * (`./dashboard.ts`), with the prototype's words (`~/Downloads/apx-prototype`).
 *
 * Money stays a Decimal until it is formatted; `toNumber()` is used only for the values a chart
 * draws. No I/O, no clock.
 */
import { Decimal, ROUND_HALF_UP, formatMoney } from '@/core/money';
import { addMonths, periodLabel, periodLabelLong, yearMonthOf, type YearMonth } from '@/core/periods';
import {
  DEPARTMENT_META, chartScale,
  type DepartmentId, type MainChart, type Mix, type MonthWindow, type PriorityIcon, type PriorityItem, type Queue,
  type ReportView, type Spark, type WindowMonth,
} from './dashboard';
import { compactMoney, shareSlices } from './dashboard-ops';

// ---------------------------------------------------------------------------------------------
// The month window
// ---------------------------------------------------------------------------------------------

export interface PeriodLike {
  readonly id: string;
  readonly periodStart: string;
  readonly isComplete: boolean;
}

/** The longest window (and the `recent` months the sparks and targets read). */
export const RECENT_MONTH_COUNT = 6;

const ymKey = (ym: YearMonth) => `${ym.year}-${String(ym.month).padStart(2, '0')}`;
const shortMonth = (ym: YearMonth) => periodLabel(ym).slice(0, 3);

/** "Sep 2026"; "Apr – Sep 2026"; "Nov 2025 – Apr 2026". */
export function windowCaption(months: readonly { readonly periodStart: string }[]): string {
  const first = months[0], last = months[months.length - 1];
  if (first === undefined || last === undefined) return '';
  const a = yearMonthOf(first.periodStart), b = yearMonthOf(last.periodStart);
  if (months.length === 1) return periodLabel(b);
  return a.year === b.year ? `${shortMonth(a)} – ${periodLabel(b)}` : `${periodLabel(a)} – ${periodLabel(b)}`;
}

/**
 * The selected months, oldest first, ending at the anchor: the latest month with figures
 * (`current`) or the latest COMPLETE month with figures (`last`). Calendar months are counted back
 * from the anchor; a month the company has no period for is skipped, and months before the first one
 * with figures are left out (a window never opens on empty months). Null when there is no anchor.
 */
export function buildMonthWindow(
  periods: readonly PeriodLike[], withData: ReadonlySet<string>, months: number, view: ReportView, currency: string,
): MonthWindow | null {
  const newest = [...periods].sort((a, b) => b.periodStart.localeCompare(a.periodStart));
  const anchor = newest.find((p) => withData.has(p.id) && (view === 'current' || p.isComplete));
  if (anchor === undefined) return null;
  const byMonth = new Map(newest.map((p) => [p.periodStart.slice(0, 7), p]));
  const anchorYm = yearMonthOf(anchor.periodStart);

  const take = (count: number): WindowMonth[] => {
    const picked: WindowMonth[] = [];
    for (let i = count - 1; i >= 0; i -= 1) {
      const ym = addMonths(anchorYm, -i);
      const period = byMonth.get(ymKey(ym));
      if (period === undefined) continue;
      picked.push({
        periodId: period.id,
        periodStart: period.periodStart,
        label: shortMonth(ym),
        longLabel: periodLabel(ym),
        isComplete: period.isComplete,
        yearEarlierPeriodId: byMonth.get(ymKey(addMonths(ym, -12)))?.id ?? null,
      });
    }
    const firstWithData = picked.findIndex((m) => withData.has(m.periodId));
    return firstWithData < 0 ? picked : picked.slice(firstWithData);
  };

  const selected = take(months);
  return {
    months: selected,
    periodCaption: windowCaption(selected),
    snapshotLabel: `${view === 'current' ? 'Current' : 'Last Completed'} · ${periodLabel(anchorYm)}`,
    reportingCutoff: `Reporting cutoff · ${periodLabelLong(anchorYm)}`,
    currency,
    recent: take(Math.max(RECENT_MONTH_COUNT, months)).slice(-RECENT_MONTH_COUNT),
  };
}

// ---------------------------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------------------------

/** One figure per period id, as a Decimal; absent or NULL → null (never zero). */
export function valuesFor(
  byPeriod: ReadonlyMap<string, string | null>, periodIds: readonly (string | null)[],
): (Decimal | null)[] {
  return periodIds.map((id) => {
    const v = id === null ? undefined : byPeriod.get(id);
    return v === undefined || v === null ? null : new Decimal(v);
  });
}

/** The sum of the known values, or null when none is known. */
export function sumKnown(values: readonly (Decimal | null)[]): Decimal | null {
  const known = values.filter((v): v is Decimal => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a.plus(b), new Decimal(0));
}

/** a − b per month, null where either is unknown. */
export function minusEach(a: readonly (Decimal | null)[], b: readonly (Decimal | null)[]): (Decimal | null)[] {
  return a.map((v, i) => (v === null || b[i] === null || b[i] === undefined ? null : v.minus(b[i]!)));
}

/** "29.6%" — part ÷ whole to one place; null when the whole is not positive or either is unknown. */
export function percentOf(part: Decimal | null, whole: Decimal | null): string | null {
  if (part === null || whole === null || !whole.greaterThan(0)) return null;
  const pct = part.dividedBy(whole).times(100).toDecimalPlaces(1, ROUND_HALF_UP);
  return `${pct.isZero() ? '0.0' : pct.toFixed(1)}%`;
}

/**
 * The like-for-like change of a total against the same months a year earlier: "+18.0%" / "−4.2%",
 * or null when any month with a current figure has no year-earlier one, when the earlier total is
 * zero, or across a change of sign (the engine's rule, FINANCIAL_ENGINE.md §3.2).
 */
export function yearOnYear(current: readonly (Decimal | null)[], earlier: readonly (Decimal | null)[]): string | null {
  let now = new Decimal(0), then = new Decimal(0), any = false;
  for (let i = 0; i < current.length; i += 1) {
    const c = current[i];
    if (c === null || c === undefined) continue;
    const e = earlier[i];
    if (e === null || e === undefined) return null;
    now = now.plus(c); then = then.plus(e); any = true;
  }
  if (!any || then.isZero()) return null;
  if ((now.isNegative() && then.greaterThan(0)) || (now.greaterThan(0) && then.isNegative())) return null;
  const pct = now.minus(then).dividedBy(then.abs()).times(100).toDecimalPlaces(1, ROUND_HALF_UP);
  if (pct.isZero()) return '0.0%';
  return `${pct.isNegative() ? '−' : '+'}${pct.abs().toFixed(1)}%`;
}

/** Whole currency units: "£170,000". */
export function wholeMoney(value: Decimal | null, currency: string): string {
  return value === null ? '—' : formatMoney(value.toFixed(2), { currency, showMinorUnits: false });
}

/** A Decimal for drawing only. */
const draw = (v: Decimal | null): number | null => (v === null ? null : v.toNumber());

/**
 * The prototype's spark over some months: with month labels (`monthSpark`, the three-month trend)
 * or plain (`spark`). Months without a figure are left out; nothing known → null.
 */
export function moneySpark(
  months: readonly WindowMonth[], values: readonly (Decimal | null)[], currency: string, labelled: boolean,
): Spark | null {
  const known = months.map((m, i) => ({ m, v: values[i] ?? null })).filter((x): x is { m: WindowMonth; v: Decimal } => x.v !== null);
  if (known.length === 0) return null;
  return {
    values: known.map((x) => x.v.toNumber()),
    labels: labelled ? known.map((x) => x.m.label) : null,
    titles: known.map((x) => `${x.m.label} ${wholeMoney(x.v, currency)}`),
  };
}

// ---------------------------------------------------------------------------------------------
// The main chart
// ---------------------------------------------------------------------------------------------

export interface MoneyChartInput {
  readonly dept: DepartmentId;
  readonly window: MonthWindow;
  readonly first: readonly (Decimal | null)[];
  readonly second: readonly (Decimal | null)[];
  /** The same months a year earlier; null when none of them has a figure. */
  readonly baseline: readonly (Decimal | null)[] | null;
  /** "revenue", "cash received": what the dashed line is, in the description. */
  readonly baselineWhat: string;
  readonly insight: string;
  readonly figure: string;
}

/** The main chart for a money department: drawing values, titles, ticks, the table and the summary. */
export function moneyChart(input: MoneyChartInput): MainChart {
  const { dept, window } = input;
  const currency = window.currency;
  const meta = DEPARTMENT_META[dept];
  const [firstName, secondName] = meta.series;
  const labels = window.months.map((m) => m.label);
  const baseline = input.baseline !== null && input.baseline.some((v) => v !== null) ? input.baseline : null;
  const first = input.first.map(draw), second = input.second.map(draw);
  const drawnBaseline = baseline === null ? null : baseline.map(draw);
  const scale = chartScale([...first, ...second, ...(drawnBaseline ?? [])]);
  return {
    kicker: 'PERFORMANCE OVER TIME',
    title: meta.chart,
    series: meta.series,
    unit: 'money',
    labels,
    first,
    second,
    baseline: drawnBaseline,
    baselineLabel: 'Same months last year',
    firstTitles: labels.map((l, i) => `${l} · ${firstName}: ${wholeMoney(input.first[i] ?? null, currency)}`),
    secondTitles: labels.map((l, i) => `${l} · ${secondName}: ${wholeMoney(input.second[i] ?? null, currency)}`),
    ticks: scale.ticks.map((t) => compactMoney(new Decimal(t), currency)),
    cap: scale.cap,
    insight: input.insight,
    figure: input.figure,
    rows: window.months.map((m, i) => ({
      period: m.longLabel,
      first: wholeMoney(input.first[i] ?? null, currency),
      second: wholeMoney(input.second[i] ?? null, currency),
      baseline: wholeMoney(baseline?.[i] ?? null, currency),
    })),
    description: `${window.periodCaption}. ${firstName} and ${secondName.toLowerCase()}`
      + `${baseline === null ? '.' : `; the dashed grey line is ${input.baselineWhat} in the same months last year.`}`
      + ' Use View chart data for exact values.',
  };
}

// ---------------------------------------------------------------------------------------------
// The mix
// ---------------------------------------------------------------------------------------------

export interface RevenueMixInput {
  readonly revenue: Decimal | null;
  readonly otherIncome: Decimal | null;
  /** Revenue by customer over the window, largest first. */
  readonly customers: readonly { readonly name: string; readonly value: Decimal }[];
  readonly currency: string;
}

/**
 * Financial Analysis' "Revenue mix": the largest customer, the rest of sales and other income when
 * there is any; otherwise the two largest customers and the rest of sales; without customer figures,
 * sales and other income (or sales alone).
 */
export function revenueMix(input: RevenueMixInput): Mix {
  const title = DEPARTMENT_META.analysis.mix;
  const { revenue, currency } = input;
  if (revenue === null || !revenue.greaterThan(0)) {
    return { title, total: compactMoney(revenue, currency), caption: 'total revenue', slices: [] };
  }
  const other = input.otherIncome !== null && input.otherIncome.greaterThan(0) ? input.otherIncome : null;
  const [top, second] = input.customers.filter((c) => c.value.greaterThan(0));
  const rest = (taken: Decimal) => (revenue.minus(taken).isNegative() ? [] : [{ label: 'Other sales', value: revenue.minus(taken) }]);

  let entries: { label: string; value: Decimal }[];
  if (top === undefined) {
    entries = [{ label: 'Sales', value: revenue }, ...(other ? [{ label: 'Other income', value: other }] : [])];
  } else if (other) {
    entries = [{ label: top.name, value: top.value }, ...rest(top.value), { label: 'Other income', value: other }];
  } else {
    entries = [
      { label: top.name, value: top.value },
      ...(second ? [{ label: second.name, value: second.value }] : []),
      ...rest(top.value.plus(second?.value ?? 0)),
    ];
  }
  return {
    title,
    total: compactMoney(other ? revenue.plus(other) : revenue, currency),
    caption: other ? 'total income' : 'total revenue',
    slices: shareSlices(entries),
  };
}

/** Banking's "Spending by category": the two largest categories and everything else. */
export function spendingMix(categories: readonly { readonly label: string; readonly value: Decimal }[], currency: string): Mix {
  const sorted = categories.filter((c) => c.value.greaterThan(0))
    .sort((a, b) => b.value.comparedTo(a.value) || a.label.localeCompare(b.label));
  const total = sorted.reduce((s, c) => s.plus(c.value), new Decimal(0));
  const rest = sorted.slice(2).reduce((s, c) => s.plus(c.value), new Decimal(0));
  return {
    title: DEPARTMENT_META.banking.mix,
    total: sorted.length === 0 ? compactMoney(null, currency) : compactMoney(total, currency),
    caption: 'total spending',
    slices: shareSlices([...sorted.slice(0, 2), ...(rest.greaterThan(0) ? [{ label: 'Other', value: rest }] : [])]),
  };
}

// ---------------------------------------------------------------------------------------------
// The priorities queue (alerts)
// ---------------------------------------------------------------------------------------------

/** What the queue reads of an alert (`AlertView` in `modules/dashboard`), kept structural. */
export interface AlertLike {
  readonly id: string;
  readonly ruleKey: string;
  readonly family: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  readonly status: 'open' | 'acknowledged' | 'resolved' | 'dismissed';
  readonly title: string;
  readonly whatHappened: string;
  readonly whyItMatters: string | null;
  readonly whatYouCanDo: string | null;
  readonly periodLabel: string;
  readonly detailHref: string;
}

export const QUEUE_LIMIT = 6;

const SEVERITY_RANK: Readonly<Record<AlertLike['severity'], number>> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEVERITY_WORD: Readonly<Record<AlertLike['severity'], string>> = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Information',
};

/** The prototype's tag words: "Action", "Investigate", "Review". */
export function severityTag(severity: AlertLike['severity']): string {
  if (severity === 'critical' || severity === 'high') return 'Action';
  if (severity === 'medium') return 'Investigate';
  return 'Review';
}

/** The rule families that belong to Banking: cash, collections, bills, regular and bank payments. */
const BANKING_RULE_PREFIXES = ['cash.', 'receivables.', 'payables.', 'recurring.', 'duplicate.', 'bank.'];

export function isBankingAlert(alert: Pick<AlertLike, 'ruleKey'>): boolean {
  return BANKING_RULE_PREFIXES.some((p) => alert.ruleKey.startsWith(p));
}

export function alertIcon(ruleKey: string): PriorityIcon {
  if (/^(revenue|margin|variance)\./.test(ruleKey)) return 'chart';
  if (/^(expense|deviation|duplicate)\./.test(ruleKey)) return 'search';
  if (isBankingAlert({ ruleKey })) return 'bank';
  if (ruleKey.startsWith('concentration.')) return 'client';
  return 'shield';
}

/**
 * Open alerts (worst first, up to `limit`), then acknowledged ones as reviewed — so the queue's
 * "Reviewed" and "All items" filters have something to show. `requested` = a review request already
 * exists (its engagement item title is `requestTitle(alert title)`).
 */
export function alertQueueItems(
  alerts: readonly AlertLike[], requestedTitles: ReadonlySet<string>, requestTitle: (title: string) => string,
  limit = QUEUE_LIMIT,
): PriorityItem[] {
  const rank = (list: readonly AlertLike[]) => list
    .map((a, i) => ({ a, i }))
    .sort((x, y) => SEVERITY_RANK[x.a.severity] - SEVERITY_RANK[y.a.severity] || x.i - y.i)
    .map((x) => x.a)
    .slice(0, limit);
  const open = rank(alerts.filter((a) => a.status === 'open'));
  const reviewed = rank(alerts.filter((a) => a.status === 'acknowledged'));
  return [...open, ...reviewed].map((a) => ({
    id: `alert:${a.id}`,
    kind: 'alert',
    recordId: a.id,
    title: a.title,
    subtitle: [a.family, `${SEVERITY_WORD[a.severity]} priority`, a.periodLabel].filter(Boolean).join(' · '),
    tag: severityTag(a.severity),
    icon: alertIcon(a.ruleKey),
    context: a.whatHappened,
    nextStep: a.whatYouCanDo ?? a.whyItMatters ?? 'Open the alert to see the figures behind it.',
    href: a.detailHref,
    reviewed: a.status === 'acknowledged',
    requested: requestedTitles.has(requestTitle(a.title).trim()),
  }));
}

/**
 * The queue's frame: the reader who may mark items reviewed sees the analyst's review workspace,
 * everyone else the client's next moves (the prototype's two roles, decided by permission).
 */
export function alertQueue(items: readonly PriorityItem[], mayMarkReviewed: boolean): Queue {
  return mayMarkReviewed
    ? { kicker: 'YOUR REVIEW WORKSPACE', title: 'Analyst review queue', footnote: 'Open an observation to record a review.', reviewedWord: 'Reviewed', items }
    : {
      kicker: 'YOUR NEXT MOVES', title: 'Priorities & observations',
      footnote: 'Select an item to see the context and request a review from your analyst.', reviewedWord: 'Reviewed', items,
    };
}
