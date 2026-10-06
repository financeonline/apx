/**
 * Calendar-month period maths, fiscal-year mapping and period completeness
 * (ADR-007, ADR-030, ADR-047.6, CD-09).
 *
 * Pure: no I/O, no Supabase, no React, and no ambient clock — "now" is always injected as a
 * `Clock` (ADR-030.5, FINANCIAL_ENGINE.md §1.1).
 */

export { systemClock, fixedClock, type Clock } from './clock';

export {
  addMonths,
  compareYearMonth,
  daysInMonth,
  isLeapYear,
  iterateMonths,
  monthEnd,
  monthName,
  monthRange,
  monthStart,
  monthsBetween,
  parseIsoDate,
  periodLabel,
  periodLabelLong,
  sameYearMonth,
  subtractMonths,
  yearMonth,
  yearMonthOf,
  type IsoDate,
  type YearMonth,
} from './months';

export {
  assertFiscalYearStartMonth,
  fiscalMonthIndex,
  fiscalPosition,
  fiscalQuarter,
  fiscalYear,
  fiscalYearEnd,
  fiscalYearStart,
  isFirstFiscalMonth,
  sameFiscalYear,
  type FiscalPosition,
  type FiscalYearStartMonth,
} from './fiscal';

export { addDays, currentYearMonth, isoWeekday, startOfLocalDay, todayInTimeZone } from './timezone';

export {
  bankCoverageFromRatio,
  completenessHolds,
  isPeriodComplete,
  latestCompletePeriod,
  type CompletenessFacts,
  type BankCoverage,
  type LatestPeriod,
  type OrganizationCoverage,
  type PeriodCoverage,
  type PeriodStatus,
} from './completeness';
