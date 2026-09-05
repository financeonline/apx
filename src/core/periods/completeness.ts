import { ValidationError } from '@/core/errors';
import { monthEnd, monthStart, parseIsoDate, yearMonthOf, type IsoDate, type YearMonth } from './months';

/**
 * Period completeness (ADR-030.1 as refined by ADR-047.6, FINANCIAL_ENGINE.md §2.2).
 *
 * ADR-030.1: "The rule lives in `core/periods` and is cited by both" — Home/Insights/Reports and
 * the AI Analyst default to the same period because they call the same function.
 *
 * The rule reads the **declared export range** (`import_batches.period_start/period_end`, confirmed
 * by the reviewer at `IMP-RANGE-015`), never the last posting date. ADR-047.6 deletes the earlier
 * "last posting date + 3 days" heuristic outright: a month whose last working day is the 28th is
 * covered by an export declared to the 31st, and the heuristic used to call that month incomplete.
 *
 * This module is pure. It does no database access: the caller computes coverage per
 * FINANCIAL_ENGINE.md §2.2/§2.3 and hands the facts in.
 */

/** Per FINANCIAL_ENGINE.md §2.2: every active cash-like account covered, some, or none. */
export type BankCoverage = 'full' | 'partial' | 'none';

export interface PeriodCoverage {
  /** `fiscal_periods.id`. */
  periodId: string;
  /** `fiscal_periods.period_start`, `YYYY-MM-DD`. */
  periodStart: IsoDate;
  /** `fiscal_periods.period_end`, `YYYY-MM-DD`. */
  periodEnd: IsoDate;
  /**
   * "Latest data date" for the P&L source chosen for this period by §2.3 precedence: the maximum
   * declared `import_batches.period_end` over that source's committed, non-rolled-back batches.
   * `null` when no source covers the P&L family for this period.
   */
  pnlLatestDataDate: IsoDate | null;
  /** Coverage of the period by committed statement batches across active cash-like accounts. */
  bankCoverage: BankCoverage;
  /** Whether any accepted record of any source falls in this period. Drives the `partial` fallback. */
  hasAcceptedData: boolean;
}

export interface OrganizationCoverage {
  /**
   * ADR-047.6's exception: an organization with no active cash-like account (`is_active`,
   * `account_type ∈ {current, savings}`) is complete on its P&L source alone. Without this a
   * ledger-only organization would never have a complete month.
   */
  hasActiveCashLikeAccount: boolean;
  periods: PeriodCoverage[];
}

export type PeriodStatus = 'complete' | 'partial';

export interface LatestPeriod {
  periodId: string;
  period: YearMonth;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  /**
   * `partial` is the fallback: no period is complete, so the latest period holding accepted data is
   * returned and the surfaces show the "{Month} so far" treatment (ADR-047.6, ADR-030.1).
   */
  status: PeriodStatus;
}

/** ISO dates sort lexicographically, but only once each is known to be a real `YYYY-MM-DD` date. */
function compareIsoDates(a: IsoDate, b: IsoDate): number {
  parseIsoDate(a);
  parseIsoDate(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertConsistent(period: PeriodCoverage): void {
  const ym = yearMonthOf(period.periodStart);
  // A fiscal period is exactly one calendar month (ADR-007). A row that is not would silently
  // change what "the latest data date reaches the end of the period" means.
  if (period.periodStart !== monthStart(ym) || period.periodEnd !== monthEnd(ym)) {
    throw new ValidationError('A fiscal period must be exactly one calendar month.', [
      {
        path: 'period',
        message: `${period.periodId}: ${period.periodStart} → ${period.periodEnd}`,
      },
    ]);
  }
}

/**
 * `fiscal_periods.is_complete` (ADR-047.6).
 *
 * = the chosen P&L source's latest data date reaches the end of the period
 *   AND (bank coverage is full OR the organization has no active cash-like account).
 *
 * DOCUMENT CONFLICT, resolved in favour of the formula. FINANCIAL_ENGINE.md §2.2 and ADR-047.6
 * both state the formula above and then add "Partial bank coverage is a data-quality warning, not
 * incompleteness". The two cannot both hold: the formula requires `full`. The formula is
 * implemented, because it is the operative rule and is repeated in the same words in ADR-030.1 and
 * DATABASE_ARCHITECTURE.md §2, while the trailing sentence is a justification whose worked example
 * ("a GL organization with quarterly statements still gets complete months") is satisfied by the
 * formula anyway: a quarterly statement's *declared range* spans each of its three months, so
 * coverage of every one of them is `full`. `partial` means an active cash-like account with **no**
 * statement batch spanning the period, which is a different thing. Flagged for the product owner.
 */
export function isPeriodComplete(
  period: PeriodCoverage,
  hasActiveCashLikeAccount: boolean,
): boolean {
  assertConsistent(period);
  const pnlReachesPeriodEnd =
    period.pnlLatestDataDate !== null &&
    compareIsoDates(period.pnlLatestDataDate, period.periodEnd) >= 0;
  const cashSatisfied = !hasActiveCashLikeAccount || period.bankCoverage === 'full';
  return pnlReachesPeriodEnd && cashSatisfied;
}

function toLatest(period: PeriodCoverage, status: PeriodStatus): LatestPeriod {
  return {
    periodId: period.periodId,
    period: yearMonthOf(period.periodStart),
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    status,
  };
}

/**
 * The period Home, Insights, Reports and the AI Analyst open on (ADR-030.1).
 *
 * The latest complete period; failing that the latest period holding accepted data, flagged
 * `partial`; failing that `null`, because an organization with no data has no period to default to
 * and must be shown an empty state rather than an arbitrary month.
 */
export function latestCompletePeriod(coverage: OrganizationCoverage): LatestPeriod | null {
  let latestComplete: PeriodCoverage | null = null;
  let latestWithData: PeriodCoverage | null = null;

  for (const period of coverage.periods) {
    assertConsistent(period);
    if (isPeriodComplete(period, coverage.hasActiveCashLikeAccount)) {
      if (latestComplete === null || compareIsoDates(period.periodStart, latestComplete.periodStart) > 0) {
        latestComplete = period;
      }
    }
    if (period.hasAcceptedData) {
      if (latestWithData === null || compareIsoDates(period.periodStart, latestWithData.periodStart) > 0) {
        latestWithData = period;
      }
    }
  }

  if (latestComplete !== null) return toLatest(latestComplete, 'complete');
  if (latestWithData !== null) return toLatest(latestWithData, 'partial');
  return null;
}
