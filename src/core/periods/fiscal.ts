import { ValidationError } from '@/core/errors';
import { addMonths, yearMonth, type YearMonth } from './months';

/**
 * Fiscal-year mapping (ADR-007, CD-09: "Fiscal-year start month is an organization setting
 * (default January). Quarters and years are aggregates of months").
 *
 * These derive exactly what the database stores on `fiscal_periods.fiscal_year` and
 * `fiscal_quarter`, and what ADR-027.2/ADR-047.4 mean by "the same fiscal year" when differencing
 * cumulative trial balances. The batch-frozen `import_batches.fiscal_year_start_month_at_commit` is
 * the value passed in for that differencing, not the organization's current setting.
 */

/** `organizations.fiscal_year_start_month smallint 1..12 DEFAULT 1`. */
export type FiscalYearStartMonth = number;

export function assertFiscalYearStartMonth(month: number): FiscalYearStartMonth {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ValidationError('The fiscal year must start in a real month.', [
      { path: 'fiscal_year_start_month', message: `${month} is not between 1 and 12.` },
    ]);
  }
  return month;
}

/**
 * Position of a month within its fiscal year, 1–12. The fiscal year's first month is 1.
 *
 * ADR-027.2's "the first fiscal month uses `closing(P)`" is `fiscalMonthIndex === 1`.
 */
export function fiscalMonthIndex(ym: YearMonth, fiscalYearStartMonth: number): number {
  const start = assertFiscalYearStartMonth(fiscalYearStartMonth);
  const { month } = yearMonth(ym.year, ym.month);
  return ((month - start + 12) % 12) + 1;
}

/**
 * `fiscal_periods.fiscal_year`.
 *
 * CONVENTION (not stated in any document — see CD-09, which specifies the start month and nothing
 * about the label): a fiscal year is named by the **calendar year in which it starts**. An
 * organization whose year starts in April therefore has FY2026 running Apr 2026 → Mar 2027. This
 * agrees with the only worked example in the documents, "Q1 2026 (Jan–Mar)"
 * (UX_ARCHITECTURE.md §8.2), where the January-start case labels the year by its first month.
 * If the product owner wants the UK "FY2026-27 is named 2027" convention instead, this function is
 * the single place it changes.
 */
export function fiscalYear(ym: YearMonth, fiscalYearStartMonth: number): number {
  const start = assertFiscalYearStartMonth(fiscalYearStartMonth);
  const { year, month } = yearMonth(ym.year, ym.month);
  return month >= start ? year : year - 1;
}

/** `fiscal_periods.fiscal_quarter`, 1–4, counted from the fiscal year's first month. */
export function fiscalQuarter(ym: YearMonth, fiscalYearStartMonth: number): number {
  return Math.ceil(fiscalMonthIndex(ym, fiscalYearStartMonth) / 3);
}

/** The first month of the fiscal year `ym` belongs to. */
export function fiscalYearStart(ym: YearMonth, fiscalYearStartMonth: number): YearMonth {
  const index = fiscalMonthIndex(ym, fiscalYearStartMonth);
  return addMonths(ym, -(index - 1));
}

/** The last month of the fiscal year `ym` belongs to. */
export function fiscalYearEnd(ym: YearMonth, fiscalYearStartMonth: number): YearMonth {
  return addMonths(fiscalYearStart(ym, fiscalYearStartMonth), 11);
}

/** True for the fiscal year's opening month — the cumulative-differencing reset (ADR-027.2). */
export function isFirstFiscalMonth(ym: YearMonth, fiscalYearStartMonth: number): boolean {
  return fiscalMonthIndex(ym, fiscalYearStartMonth) === 1;
}

/** True when both months sit in the same fiscal year of the same organization. */
export function sameFiscalYear(
  a: YearMonth,
  b: YearMonth,
  fiscalYearStartMonth: number,
): boolean {
  return fiscalYear(a, fiscalYearStartMonth) === fiscalYear(b, fiscalYearStartMonth);
}

/** Everything the `fiscal_periods` row derives from a month, in one call. */
export interface FiscalPosition {
  fiscalYear: number;
  fiscalQuarter: number;
  fiscalMonthIndex: number;
}

export function fiscalPosition(ym: YearMonth, fiscalYearStartMonth: number): FiscalPosition {
  return {
    fiscalYear: fiscalYear(ym, fiscalYearStartMonth),
    fiscalQuarter: fiscalQuarter(ym, fiscalYearStartMonth),
    fiscalMonthIndex: fiscalMonthIndex(ym, fiscalYearStartMonth),
  };
}
