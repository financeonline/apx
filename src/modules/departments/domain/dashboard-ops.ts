/**
 * Pure helpers for the count-based departments of the department dashboard (ADR-180) — Data
 * Capture, Manage Workflow and Client Management — shared by `services/dashboard/{capture,workflow,
 * clients}.ts`. They turn dated records into the prototype's monthly series, and series into the
 * contract's chart, spark and mix (`./dashboard.ts`). No I/O, no clock: "today" is always passed in.
 */
import { Decimal, ROUND_HALF_UP, formatMoney } from '@/core/money';
import {
  DEPARTMENT_IDS, DEPARTMENT_META, chartScale,
  type DepartmentId, type MainChart, type MixSlice, type MonthWindow, type Spark,
} from './dashboard';

// ---------------------------------------------------------------------------------------------
// Dates and months
// ---------------------------------------------------------------------------------------------

/** "2026-04" from "2026-04-17" or "2026-04-17T09:30:00Z"; null for anything else. */
export function monthKey(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : null;
}

/** The same month a year earlier: "2026-04-01" → "2025-04". */
export function yearEarlierKey(periodStart: string): string {
  return `${String(Number(periodStart.slice(0, 4)) - 1).padStart(4, '0')}-${periodStart.slice(5, 7)}`;
}

/** The last day of the month that starts at `periodStart`: "2026-09-01" → "2026-09-30". */
export function monthEndOf(periodStart: string): string {
  const year = Number(periodStart.slice(0, 4));
  const month = Number(periodStart.slice(5, 7));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${periodStart.slice(0, 7)}-${String(days).padStart(2, '0')}`;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "05 Nov 2026", the prototype's date (two-digit day, "Sep" never "Sept"); "—" when unreadable. */
export function dayLabel(date: string | null | undefined): string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(date)) return '—';
  const month = Number(date.slice(5, 7));
  if (month < 1 || month > 12) return '—';
  return `${date.slice(8, 10)} ${SHORT_MONTHS[month - 1]} ${date.slice(0, 4)}`;
}

/** How many of `dates` fall in each month of `keys` ("YYYY-MM"), in order. */
export function countByMonth(dates: readonly (string | null | undefined)[], keys: readonly string[]): number[] {
  const tally = new Map<string, number>();
  for (const date of dates) {
    const key = monthKey(date);
    if (key !== null) tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return keys.map((key) => tally.get(key) ?? 0);
}

/**
 * The year-earlier counts as a baseline: a month whose year-earlier month predates the company's
 * first record is a gap (null), not a zero; all gaps → null (no baseline line at all).
 */
export function countBaseline(
  dates: readonly (string | null | undefined)[], window: MonthWindow,
): (number | null)[] | null {
  const keys = dates.map(monthKey).filter((k): k is string => k !== null).sort();
  const earliest = keys[0];
  if (earliest === undefined) return null;
  const earlierKeys = window.months.map((m) => yearEarlierKey(m.periodStart));
  const counts = countByMonth(dates, earlierKeys);
  const values = earlierKeys.map((key, i) => (key >= earliest ? counts[i]! : null));
  return values.every((v) => v === null) ? null : values;
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

const COUNT = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const TICK = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

/** "1,240". */
export function formatCount(n: number): string {
  return COUNT.format(n);
}

/** "3 documents", "1 document". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** part ÷ whole as a percentage to one decimal place, or null when there is nothing to divide by. */
export function rate(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** "96.5%"; "—" when there is no rate. */
export function rateLabel(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

/** The prototype's compact money (the same rules as `modules/marketing`): "£1.69m", "£234.7k", "£950". */
export function compactMoney(value: Decimal | string | null, currency: string): string {
  if (value === null) return '—';
  const d = new Decimal(value);
  const symbol = formatMoney(0, { currency }).replace(/[\d.,\s]/g, '');
  const sign = d.isNegative() ? '−' : '';
  const a = d.abs();
  const trim = (s: string) => s.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  // The unit is chosen AFTER rounding, so £999,950 reads "£1m", never "£1000k" (as `modules/marketing`).
  const thousands = a.dividedBy(1_000).toDecimalPlaces(1, ROUND_HALF_UP);
  if (thousands.greaterThanOrEqualTo(1_000)) return `${sign}${symbol}${trim(a.dividedBy(1_000_000).toDecimalPlaces(2, ROUND_HALF_UP).toFixed(2))}m`;
  const whole = a.toDecimalPlaces(0, ROUND_HALF_UP);
  if (whole.greaterThanOrEqualTo(1_000)) return `${sign}${symbol}${trim(thousands.toFixed(1))}k`;
  return `${sign}${symbol}${whole.toFixed(0)}`;
}

/**
 * The chart scale for counts: the prototype's `chartScale`, with the cap raised to a multiple of
 * four so the five gridlines are whole numbers (a "2.5 documents" tick means nothing).
 */
export function countScale(values: readonly (number | null)[]): { cap: number; ticks: readonly number[] } {
  const { cap } = chartScale(values);
  const whole = Math.max(4, Math.ceil(cap / 4) * 4);
  return { cap: whole, ticks: [0, 1, 2, 3, 4].map((i) => (whole * i) / 4) };
}

// ---------------------------------------------------------------------------------------------
// The contract's pieces
// ---------------------------------------------------------------------------------------------

/** The view's heading fields: name, "03 / BUILD RELIABLE FOUNDATIONS" and the window's captions. */
export function departmentHeading(id: DepartmentId, window: MonthWindow): {
  id: DepartmentId; name: string; kicker: string; periodCaption: string; snapshotLabel: string; reportingCutoff: string;
} {
  const meta = DEPARTMENT_META[id];
  return {
    id,
    name: meta.name,
    kicker: `0${DEPARTMENT_IDS.indexOf(id) + 1} / ${meta.kicker}`,
    periodCaption: window.periodCaption,
    snapshotLabel: window.snapshotLabel,
    reportingCutoff: window.reportingCutoff,
  };
}

/** A plain spark (the prototype's `spark`): one point per window month, titled "Jul 12". */
export function countSpark(window: MonthWindow, values: readonly number[], format: (n: number) => string = formatCount): Spark {
  return {
    values: [...values],
    labels: null,
    titles: window.months.map((m, i) => `${m.label} ${format(values[i] ?? 0)}`),
  };
}

export interface CountChartInput {
  readonly dept: DepartmentId;
  readonly window: MonthWindow;
  readonly first: readonly number[];
  readonly second: readonly number[];
  readonly baseline: readonly (number | null)[] | null;
  readonly insight: string;
  readonly figure: string;
}

/** The main chart for a count department (unit `count`), with the table rows and the summary. */
export function countChart(input: CountChartInput): MainChart {
  const { dept, window, first, second, baseline } = input;
  const meta = DEPARTMENT_META[dept];
  const [firstName, secondName] = meta.series;
  const labels = window.months.map((m) => m.label);
  const scale = countScale([...first, ...second, ...(baseline ?? [])]);
  const cell = (v: number | null | undefined) => (v === null || v === undefined ? '—' : formatCount(v));
  const total = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
  return {
    kicker: dept === 'workflow' ? 'WORKFLOW PROGRESS' : 'PERFORMANCE OVER TIME',
    title: meta.chart,
    series: meta.series,
    unit: 'count',
    labels,
    first: [...first],
    second: [...second],
    baseline: baseline === null ? null : [...baseline],
    baselineLabel: 'Same months last year',
    firstTitles: labels.map((l, i) => `${l} · ${firstName}: ${cell(first[i])}`),
    secondTitles: labels.map((l, i) => `${l} · ${secondName}: ${cell(second[i])}`),
    ticks: scale.ticks.map((t) => TICK.format(t)),
    cap: scale.cap,
    insight: input.insight,
    figure: input.figure,
    rows: window.months.map((m, i) => ({
      period: m.longLabel, first: cell(first[i]), second: cell(second[i]), baseline: cell(baseline?.[i] ?? null),
    })),
    description: `${meta.chart}, ${window.periodCaption}: ${firstName.toLowerCase()} ${formatCount(total(first))}, `
      + `${secondName.toLowerCase()} ${formatCount(total(second))}. ${input.insight}`,
  };
}

/**
 * Up to three slices with whole-number shares that add up to exactly 100 (largest remainder), in
 * the order given; empty or zero entries are left out, and nothing at all → no slices.
 */
export function shareSlices(entries: readonly { readonly label: string; readonly value: Decimal | number }[]): MixSlice[] {
  const kept = entries
    .map((e) => ({ label: e.label, value: new Decimal(e.value) }))
    .filter((e) => e.value.greaterThan(0))
    .slice(0, 3);
  const total = kept.reduce((sum, e) => sum.plus(e.value), new Decimal(0));
  if (total.isZero()) return [];
  const exact = kept.map((e) => e.value.dividedBy(total).times(100));
  const floors = exact.map((x) => x.floor().toNumber());
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, rest: x.minus(x.floor()) }))
    .sort((a, b) => b.rest.comparedTo(a.rest) || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = floors[i]! + 1;
    left -= 1;
  }
  return kept.map((e, i) => ({ label: e.label, share: floors[i]!, shareDisplay: `${floors[i]}%` }));
}

// ---------------------------------------------------------------------------------------------
// Department groupings
// ---------------------------------------------------------------------------------------------

/** Data Capture's "Document sources": import types grouped into three. */
export const CAPTURE_SOURCE_LABELS = ['Bank statements', 'Accounts', 'Invoices & other'] as const;

export function captureSource(importType: string): (typeof CAPTURE_SOURCE_LABELS)[number] {
  if (importType === 'bank_statement') return 'Bank statements';
  if (['general_ledger', 'trial_balance', 'pnl_report', 'balance_sheet'].includes(importType)) return 'Accounts';
  return 'Invoices & other';
}

/** Manage Workflow's "Open tasks by workstream": an action's source grouped into three. */
export const WORKSTREAM_LABELS = ['From alerts', 'From the AI analyst & reports', 'Added by your team'] as const;

export function workstream(sourceType: string): (typeof WORKSTREAM_LABELS)[number] {
  if (sourceType === 'alert' || sourceType === 'health_score') return 'From alerts';
  if (sourceType === 'ai' || sourceType === 'report') return 'From the AI analyst & reports';
  return 'Added by your team';
}

/** Tally `items` by `group`, in the order of `labels`, as entries for `shareSlices`. */
export function groupCounts<T>(
  items: readonly T[], labels: readonly string[], group: (item: T) => string,
): { label: string; value: number }[] {
  const tally = new Map<string, number>(labels.map((l) => [l, 0]));
  for (const item of items) {
    const key = group(item);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return labels.map((label) => ({ label, value: tally.get(label) ?? 0 }));
}

// ---------------------------------------------------------------------------------------------
// Open work at a past month end
// ---------------------------------------------------------------------------------------------

/**
 * How many tasks were open at `end` (an ISO date): created on or before it and not completed by
 * then. A dismissed task carries no dismissal date, so it is left out of every month rather than
 * counted open for ever.
 */
export function openAt(
  tasks: readonly { readonly createdAt: string; readonly completedAt: string | null; readonly status: string }[],
  end: string,
): number {
  return tasks.filter((t) => t.status !== 'dismissed'
    && t.createdAt.slice(0, 10) <= end
    && (t.completedAt === null || t.completedAt.slice(0, 10) > end)).length;
}

export interface InvoiceFacts {
  readonly counterpartyId: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly status: string;
  readonly balanceDue: string;
  readonly paidDate: string | null;
}

/** An invoice that is past its due date with something still owed on `today`. */
export function isOverdueInvoice(invoice: InvoiceFacts, today: string): boolean {
  return (invoice.status === 'open' || invoice.status === 'partially_paid')
    && invoice.dueDate !== null && invoice.dueDate < today
    && new Decimal(invoice.balanceDue).greaterThan(0);
}

/**
 * The customers with an invoice overdue at a past month end `end`: issued and due by then, and not
 * paid by then (still open now, or paid after `end`). A part payment's date is not stored, so a
 * partly paid invoice counts as owed until it is fully paid.
 */
export function overdueCustomersAt(invoices: readonly InvoiceFacts[], end: string): number {
  const ids = new Set<string>();
  for (const inv of invoices) {
    if (inv.status === 'void' || inv.dueDate === null || inv.dueDate >= end || inv.issueDate > end) continue;
    const unpaidNow = inv.status === 'open' || inv.status === 'partially_paid';
    const paidLater = inv.paidDate !== null && inv.paidDate > end;
    if (unpaidNow || paidLater) ids.add(inv.counterpartyId);
  }
  return ids.size;
}
