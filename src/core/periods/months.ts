import { ValidationError } from '@/core/errors';

/**
 * Calendar-month arithmetic (ADR-007, CD-09: "Calendar months are the atomic period").
 *
 * Months are held as `{ year, month }` integers and dates as `YYYY-MM-DD` strings — the shape the
 * `date` columns (`fiscal_periods.period_start/period_end`, `import_batches.period_start/period_end`)
 * actually hold. A JS `Date` is deliberately not used: it carries a time and a zone, and adding a
 * month to one silently rolls 31 Jan into 3 March. None of the functions here look at a clock;
 * `timezone.ts` is where "today" comes from.
 */

/** A calendar month. `month` is 1–12, matching `organizations.fiscal_year_start_month`. */
export interface YearMonth {
  year: number;
  month: number;
}

/** A `date` column value, `YYYY-MM-DD`. */
export type IsoDate = string;

/**
 * `fiscal_periods.label` is `"Mar 2026"` (DATABASE_ARCHITECTURE.md §2). It is a stored column, the
 * same for every reader, so it is built from a fixed table rather than the viewer's locale.
 */
const SHORT_MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

const LONG_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function invalid(path: string, message: string): never {
  throw new ValidationError('That period could not be read.', [{ path, message }]);
}

/** Build and validate a month. Anything outside 1–12 is a caller bug, never clamped. */
export function yearMonth(year: number, month: number): YearMonth {
  if (!Number.isInteger(year)) invalid('year', `${year} is not a whole year.`);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    invalid('month', `${month} is not a month between 1 and 12.`);
  }
  return { year, month };
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function daysInMonth(ym: YearMonth): number {
  const { year, month } = yearMonth(ym.year, ym.month);
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_LENGTHS[month - 1] as number;
}

/**
 * Add `count` months, carrying into the year. Negative counts subtract, so December + 1 and
 * January − 1 cross the year boundary by the same arithmetic.
 */
export function addMonths(ym: YearMonth, count: number): YearMonth {
  if (!Number.isInteger(count)) invalid('count', `${count} is not a whole number of months.`);
  const { year, month } = yearMonth(ym.year, ym.month);
  const zeroBased = year * 12 + (month - 1) + count;
  return { year: Math.floor(zeroBased / 12), month: (((zeroBased % 12) + 12) % 12) + 1 };
}

export function subtractMonths(ym: YearMonth, count: number): YearMonth {
  return addMonths(ym, -count);
}

/** Signed count of months from `from` to `to`; negative when `to` is earlier. */
export function monthsBetween(from: YearMonth, to: YearMonth): number {
  const a = yearMonth(from.year, from.month);
  const b = yearMonth(to.year, to.month);
  return (b.year - a.year) * 12 + (b.month - a.month);
}

/** −1, 0 or 1. */
export function compareYearMonth(a: YearMonth, b: YearMonth): number {
  const diff = monthsBetween(a, b);
  return diff === 0 ? 0 : diff > 0 ? -1 : 1;
}

export function sameYearMonth(a: YearMonth, b: YearMonth): boolean {
  return monthsBetween(a, b) === 0;
}

const pad = (n: number, width: number) => String(Math.abs(n)).padStart(width, '0');

/** `fiscal_periods.period_start`. */
export function monthStart(ym: YearMonth): IsoDate {
  const { year, month } = yearMonth(ym.year, ym.month);
  return `${pad(year, 4)}-${pad(month, 2)}-01`;
}

/** `fiscal_periods.period_end` — the last day of the month, leap years included. */
export function monthEnd(ym: YearMonth): IsoDate {
  const { year, month } = yearMonth(ym.year, ym.month);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(daysInMonth(ym), 2)}`;
}

/** Read a `date` column. Rejects `2026-02-30` as well as rubbish — a real date, not just a shape. */
export function parseIsoDate(value: string): { year: number; month: number; day: number } {
  const match = ISO_DATE.exec(value.trim());
  if (!match) invalid('date', `"${value}" is not a YYYY-MM-DD date.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  yearMonth(year, month);
  if (day < 1 || day > daysInMonth({ year, month })) {
    invalid('date', `"${value}" is not a real date.`);
  }
  return { year, month, day };
}

/** The month a `date` column value falls in. */
export function yearMonthOf(date: IsoDate): YearMonth {
  const { year, month } = parseIsoDate(date);
  return { year, month };
}

/**
 * Every month from `from` to `to` inclusive, oldest first. An empty range (`to` before `from`)
 * yields nothing rather than throwing: callers routinely iterate a range that turns out to be empty.
 */
export function* iterateMonths(from: YearMonth, to: YearMonth): Generator<YearMonth> {
  const span = monthsBetween(from, to);
  for (let i = 0; i <= span; i += 1) yield addMonths(from, i);
}

export function monthRange(from: YearMonth, to: YearMonth): YearMonth[] {
  return [...iterateMonths(from, to)];
}

/** `"Mar 2026"` — the value stored in `fiscal_periods.label`. */
export function periodLabel(ym: YearMonth): string {
  const { year, month } = yearMonth(ym.year, ym.month);
  return `${SHORT_MONTH_NAMES[month - 1]} ${year}`;
}

/**
 * `"March 2026"` — the on-screen period label (UX_ARCHITECTURE.md §8.2). The stored column and the
 * rendered label differ in the documents; both spellings are produced here rather than one being
 * derived from the other at a call site.
 */
export function periodLabelLong(ym: YearMonth): string {
  const { year, month } = yearMonth(ym.year, ym.month);
  return `${LONG_MONTH_NAMES[month - 1]} ${year}`;
}

/** The month name alone, e.g. `"April"` — Home's "{Month} so far" line (ADR-030.1). */
export function monthName(ym: YearMonth): string {
  const { month } = yearMonth(ym.year, ym.month);
  return LONG_MONTH_NAMES[month - 1] as string;
}
