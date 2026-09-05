import { describe, it, expect } from 'vitest';
import { ValidationError } from '@/core/errors';
import {
  addMonths,
  assertFiscalYearStartMonth,
  compareYearMonth,
  currentYearMonth,
  daysInMonth,
  fiscalMonthIndex,
  fiscalPosition,
  fiscalQuarter,
  fiscalYear,
  fiscalYearEnd,
  fiscalYearStart,
  fixedClock,
  isFirstFiscalMonth,
  isLeapYear,
  isPeriodComplete,
  latestCompletePeriod,
  monthEnd,
  monthName,
  monthRange,
  monthStart,
  monthsBetween,
  parseIsoDate,
  periodLabel,
  periodLabelLong,
  sameFiscalYear,
  sameYearMonth,
  subtractMonths,
  systemClock,
  todayInTimeZone,
  yearMonth,
  yearMonthOf,
  type OrganizationCoverage,
  type PeriodCoverage,
} from '@/core/periods';

describe('month arithmetic (ADR-007, CD-09)', () => {
  it('adds and subtracts across a year boundary', () => {
    expect(addMonths({ year: 2025, month: 12 }, 1)).toEqual({ year: 2026, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(subtractMonths({ year: 2026, month: 1 }, 1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths({ year: 2026, month: 3 }, 12)).toEqual({ year: 2027, month: 3 });
    expect(addMonths({ year: 2026, month: 3 }, -12)).toEqual({ year: 2025, month: 3 });
    expect(addMonths({ year: 2026, month: 3 }, -26)).toEqual({ year: 2024, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, 0)).toEqual({ year: 2026, month: 1 });
  });

  it('never rolls a month end into the next month, the way Date arithmetic would', () => {
    // new Date(2026, 0, 31); d.setMonth(d.getMonth() + 1) gives 3 March. This does not.
    expect(addMonths(yearMonthOf('2026-01-31'), 1)).toEqual({ year: 2026, month: 2 });
    expect(monthEnd(addMonths(yearMonthOf('2026-01-31'), 1))).toBe('2026-02-28');
  });

  it('counts, compares and equates months', () => {
    expect(monthsBetween({ year: 2025, month: 12 }, { year: 2026, month: 3 })).toBe(3);
    expect(monthsBetween({ year: 2026, month: 3 }, { year: 2025, month: 12 })).toBe(-3);
    expect(compareYearMonth({ year: 2025, month: 12 }, { year: 2026, month: 1 })).toBe(-1);
    expect(compareYearMonth({ year: 2026, month: 1 }, { year: 2025, month: 12 })).toBe(1);
    expect(compareYearMonth({ year: 2026, month: 1 }, { year: 2026, month: 1 })).toBe(0);
    expect(sameYearMonth({ year: 2026, month: 1 }, { year: 2026, month: 1 })).toBe(true);
  });

  it('knows month lengths, including February in a leap year and a century', () => {
    expect(daysInMonth({ year: 2026, month: 2 })).toBe(28);
    expect(daysInMonth({ year: 2024, month: 2 })).toBe(29);
    expect(daysInMonth({ year: 1900, month: 2 })).toBe(28);
    expect(daysInMonth({ year: 2000, month: 2 })).toBe(29);
    expect(daysInMonth({ year: 2026, month: 4 })).toBe(30);
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2100)).toBe(false);
  });

  it('produces the period_start and period_end a fiscal_periods row holds', () => {
    expect(monthStart({ year: 2026, month: 3 })).toBe('2026-03-01');
    expect(monthEnd({ year: 2026, month: 3 })).toBe('2026-03-31');
    expect(monthEnd({ year: 2024, month: 2 })).toBe('2024-02-29');
    expect(monthStart({ year: 2026, month: 12 })).toBe('2026-12-01');
  });

  it('iterates a range inclusively, across a year boundary', () => {
    const range = monthRange({ year: 2025, month: 11 }, { year: 2026, month: 2 });
    expect(range.map(periodLabel)).toEqual(['Nov 2025', 'Dec 2025', 'Jan 2026', 'Feb 2026']);
  });

  it('iterates a 14-month span across two year boundaries', () => {
    const range = monthRange({ year: 2024, month: 12 }, { year: 2026, month: 1 });
    expect(range).toHaveLength(14);
    expect(periodLabel(range[0] as { year: number; month: number })).toBe('Dec 2024');
    expect(periodLabel(range[13] as { year: number; month: number })).toBe('Jan 2026');
  });

  it('yields a single month for a one-month range and nothing for an inverted one', () => {
    expect(monthRange({ year: 2026, month: 3 }, { year: 2026, month: 3 })).toHaveLength(1);
    expect(monthRange({ year: 2026, month: 3 }, { year: 2026, month: 2 })).toEqual([]);
  });

  it('labels a period both ways the documents spell it', () => {
    // DATABASE_ARCHITECTURE.md §2 stores "Mar 2026"; UX_ARCHITECTURE.md §8.2 renders "March 2026".
    expect(periodLabel({ year: 2026, month: 3 })).toBe('Mar 2026');
    expect(periodLabelLong({ year: 2026, month: 3 })).toBe('March 2026');
    expect(monthName({ year: 2026, month: 4 })).toBe('April');
  });

  it('rejects impossible months and dates instead of clamping them', () => {
    expect(() => yearMonth(2026, 0)).toThrow(ValidationError);
    expect(() => yearMonth(2026, 13)).toThrow(ValidationError);
    expect(() => addMonths({ year: 2026, month: 1 }, 1.5)).toThrow(ValidationError);
    expect(() => parseIsoDate('2026-02-30')).toThrow(ValidationError);
    expect(() => parseIsoDate('2026-13-01')).toThrow(ValidationError);
    expect(() => parseIsoDate('01/03/2026')).toThrow(ValidationError);
    expect(parseIsoDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
  });
});

describe('fiscal-year mapping (ADR-007, CD-09)', () => {
  it('validates the organisation setting', () => {
    expect(assertFiscalYearStartMonth(4)).toBe(4);
    expect(() => assertFiscalYearStartMonth(0)).toThrow(ValidationError);
    expect(() => assertFiscalYearStartMonth(13)).toThrow(ValidationError);
    expect(() => fiscalYear({ year: 2026, month: 1 }, 13)).toThrow(ValidationError);
  });

  describe('January start (the default: fiscal year is the calendar year)', () => {
    it('maps every quarter boundary', () => {
      const q = (month: number) => fiscalQuarter({ year: 2026, month }, 1);
      expect([q(1), q(2), q(3)]).toEqual([1, 1, 1]);
      expect([q(4), q(5), q(6)]).toEqual([2, 2, 2]);
      expect([q(7), q(8), q(9)]).toEqual([3, 3, 3]);
      expect([q(10), q(11), q(12)]).toEqual([4, 4, 4]);
    });

    it('names the year after the calendar year', () => {
      expect(fiscalYear({ year: 2026, month: 1 }, 1)).toBe(2026);
      expect(fiscalYear({ year: 2026, month: 12 }, 1)).toBe(2026);
      expect(fiscalYear({ year: 2025, month: 12 }, 1)).toBe(2025);
    });

    it('bounds the year to Jan–Dec and marks the first fiscal month', () => {
      expect(fiscalYearStart({ year: 2026, month: 7 }, 1)).toEqual({ year: 2026, month: 1 });
      expect(fiscalYearEnd({ year: 2026, month: 7 }, 1)).toEqual({ year: 2026, month: 12 });
      expect(isFirstFiscalMonth({ year: 2026, month: 1 }, 1)).toBe(true);
      expect(isFirstFiscalMonth({ year: 2026, month: 2 }, 1)).toBe(false);
    });
  });

  describe('April start (a UK fiscal year: Apr 2026 → Mar 2027)', () => {
    it('maps every quarter boundary from the fiscal first month', () => {
      const q = (year: number, month: number) => fiscalQuarter({ year, month }, 4);
      expect([q(2026, 4), q(2026, 5), q(2026, 6)]).toEqual([1, 1, 1]);
      expect([q(2026, 7), q(2026, 8), q(2026, 9)]).toEqual([2, 2, 2]);
      expect([q(2026, 10), q(2026, 11), q(2026, 12)]).toEqual([3, 3, 3]);
      expect([q(2027, 1), q(2027, 2), q(2027, 3)]).toEqual([4, 4, 4]);
    });

    it('runs the month index 1–12 from April', () => {
      expect(fiscalMonthIndex({ year: 2026, month: 4 }, 4)).toBe(1);
      expect(fiscalMonthIndex({ year: 2026, month: 12 }, 4)).toBe(9);
      expect(fiscalMonthIndex({ year: 2027, month: 3 }, 4)).toBe(12);
    });

    /**
     * The wrap-around. CONVENTION (see fiscal.ts): the fiscal year is named by the calendar year it
     * starts in, so Jan–Mar 2027 belong to FY2026. Nothing in the documents states this; if the
     * product owner picks the other convention, only these expectations and `fiscalYear` change.
     */
    it('keeps January to March in the year that started the previous April', () => {
      expect(fiscalYear({ year: 2026, month: 3 }, 4)).toBe(2025);
      expect(fiscalYear({ year: 2026, month: 4 }, 4)).toBe(2026);
      expect(fiscalYear({ year: 2026, month: 12 }, 4)).toBe(2026);
      expect(fiscalYear({ year: 2027, month: 1 }, 4)).toBe(2026);
      expect(fiscalYear({ year: 2027, month: 3 }, 4)).toBe(2026);
      expect(fiscalYear({ year: 2027, month: 4 }, 4)).toBe(2027);
    });

    it('bounds the fiscal year across the wrap-around', () => {
      expect(fiscalYearStart({ year: 2027, month: 2 }, 4)).toEqual({ year: 2026, month: 4 });
      expect(fiscalYearEnd({ year: 2026, month: 5 }, 4)).toEqual({ year: 2027, month: 3 });
      expect(isFirstFiscalMonth({ year: 2026, month: 4 }, 4)).toBe(true);
      expect(isFirstFiscalMonth({ year: 2026, month: 1 }, 4)).toBe(false);
    });

    it('groups the cumulative-differencing window by fiscal year (ADR-027.2)', () => {
      // March and April 2026 are consecutive months but different fiscal years, which is exactly
      // where cumulative trial balances must reset rather than be differenced.
      expect(sameFiscalYear({ year: 2026, month: 3 }, { year: 2026, month: 4 }, 4)).toBe(false);
      expect(sameFiscalYear({ year: 2026, month: 12 }, { year: 2027, month: 1 }, 4)).toBe(true);
    });
  });

  it('handles a December start, where the year label leads the calendar year', () => {
    expect(fiscalMonthIndex({ year: 2026, month: 12 }, 12)).toBe(1);
    expect(fiscalYear({ year: 2026, month: 12 }, 12)).toBe(2026);
    expect(fiscalYear({ year: 2027, month: 1 }, 12)).toBe(2026);
    expect(fiscalQuarter({ year: 2027, month: 2 }, 12)).toBe(1);
    expect(fiscalQuarter({ year: 2027, month: 3 }, 12)).toBe(2);
  });

  it('returns the whole fiscal_periods position in one call', () => {
    expect(fiscalPosition({ year: 2027, month: 2 }, 4)).toEqual({
      fiscalYear: 2026,
      fiscalQuarter: 4,
      fiscalMonthIndex: 11,
    });
  });
});

describe('clock injection and organisation timezone (ADR-030.5)', () => {
  it('exposes a system clock and a frozen one', () => {
    expect(systemClock.now()).toBeInstanceOf(Date);
    const clock = fixedClock('2026-03-31T23:30:00Z');
    expect(clock.now().toISOString()).toBe('2026-03-31T23:30:00.000Z');
    // The frozen instant cannot be mutated by a caller holding the returned Date.
    clock.now().setFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-03-31T23:30:00.000Z');
    expect(() => fixedClock('not a date')).toThrow(ValidationError);
  });

  it('gives two organisations either side of the date line different todays', () => {
    // 23:30 UTC on 31 March 2026: already 1 April in London and Auckland, still 31 March in
    // California. The server's own zone decides for nobody.
    const clock = fixedClock('2026-03-31T23:30:00Z');
    expect(todayInTimeZone(clock, 'Europe/London')).toBe('2026-04-01');
    expect(todayInTimeZone(clock, 'Pacific/Auckland')).toBe('2026-04-01');
    expect(todayInTimeZone(clock, 'America/Los_Angeles')).toBe('2026-03-31');
    expect(currentYearMonth(clock, 'Europe/London')).toEqual({ year: 2026, month: 4 });
    expect(currentYearMonth(clock, 'America/Los_Angeles')).toEqual({ year: 2026, month: 3 });
  });

  it('separates two organisations by a whole month at a month boundary', () => {
    // 13:00 UTC on 31 December 2025: still December in London, already January in Auckland.
    const clock = fixedClock('2025-12-31T13:00:00Z');
    expect(currentYearMonth(clock, 'Europe/London')).toEqual({ year: 2025, month: 12 });
    expect(currentYearMonth(clock, 'Pacific/Auckland')).toEqual({ year: 2026, month: 1 });
  });

  it('refuses an unknown timezone rather than falling back to the server zone', () => {
    const clock = fixedClock('2026-03-31T23:30:00Z');
    expect(() => todayInTimeZone(clock, 'Mars/Olympus_Mons')).toThrow(ValidationError);
  });
});

/**
 * `latestCompletePeriod()` (ADR-030.1 as refined by ADR-047.6, FINANCIAL_ENGINE.md §2.2).
 *
 * Each fixture is a coverage pattern the rule is meant to distinguish. Coverage comes from the
 * DECLARED export range (`import_batches.period_end`), never from the last posting date: the 3-day
 * heuristic is deleted by ADR-047.6, and the first fixture is the case it used to get wrong.
 */
describe('latestCompletePeriod()', () => {
  const months: Array<[string, string, string]> = [
    ['p-2025-11', '2025-11-01', '2025-11-30'],
    ['p-2025-12', '2025-12-01', '2025-12-31'],
    ['p-2026-01', '2026-01-01', '2026-01-31'],
    ['p-2026-02', '2026-02-01', '2026-02-28'],
  ];

  function period(index: number, overrides: Partial<PeriodCoverage>): PeriodCoverage {
    const [periodId, periodStart, periodEnd] = months[index] as [string, string, string];
    return {
      periodId,
      periodStart,
      periodEnd,
      pnlLatestDataDate: null,
      bankCoverage: 'none',
      hasAcceptedData: false,
      ...overrides,
    };
  }

  /**
   * Pattern 1 — ledger organisation on quarterly bank statements (the ADR-047.6 example).
   *
   * The GL export declares 1 Nov 2025 → 31 Jan 2026 and its last posting is the 28th; one quarterly
   * statement declares the same range. Under declared-range coverage every month in the range is
   * covered for both sources, so January is complete. The deleted "last posting date + 3 days"
   * heuristic would have made January incomplete and dropped the month to the bank proxy.
   */
  it('returns the latest month the declared export range covers, not the last posting date', () => {
    const coverage: OrganizationCoverage = {
      hasActiveCashLikeAccount: true,
      periods: [
        period(0, { pnlLatestDataDate: '2026-01-31', bankCoverage: 'full', hasAcceptedData: true }),
        period(1, { pnlLatestDataDate: '2026-01-31', bankCoverage: 'full', hasAcceptedData: true }),
        period(2, { pnlLatestDataDate: '2026-01-31', bankCoverage: 'full', hasAcceptedData: true }),
        period(3, { pnlLatestDataDate: '2026-01-31', bankCoverage: 'none', hasAcceptedData: true }),
      ],
    };
    const latest = latestCompletePeriod(coverage);
    expect(latest).not.toBeNull();
    expect(latest?.periodId).toBe('p-2026-01');
    expect(latest?.status).toBe('complete');
    expect(periodLabel(latest!.period)).toBe('Jan 2026');
    // February is not complete: the declared range stops at 31 January.
    expect(isPeriodComplete(coverage.periods[3] as PeriodCoverage, true)).toBe(false);
  });

  /**
   * DOCUMENT CONFLICT (see completeness.ts). The formula requires bank coverage `full`; the
   * sentence after it in both FINANCIAL_ENGINE.md §2.2 and ADR-047.6 says partial coverage is "not
   * incompleteness". The formula is implemented, because it is the operative rule and is repeated
   * in DATABASE_ARCHITECTURE.md §2 and ADR-030.1. This test pins the behaviour so that flipping it
   * is a deliberate, visible change.
   */
  it('treats a month with an uncovered active cash account as incomplete (formula, not prose)', () => {
    const latest = latestCompletePeriod({
      hasActiveCashLikeAccount: true,
      periods: [
        period(1, { pnlLatestDataDate: '2026-01-31', bankCoverage: 'full', hasAcceptedData: true }),
        period(2, { pnlLatestDataDate: '2026-01-31', bankCoverage: 'partial', hasAcceptedData: true }),
      ],
    });
    expect(latest?.periodId).toBe('p-2025-12');
    expect(latest?.status).toBe('complete');
  });

  /**
   * Pattern 2 — organisation with no active cash-like bank account.
   *
   * ADR-047.6's exception. Without it a ledger-only organisation would never see a complete month,
   * because bank coverage can never be `full` when there is nothing to cover.
   */
  it('ignores bank coverage entirely when the organisation has no cash-like account', () => {
    const periods = [
      period(0, { pnlLatestDataDate: '2026-02-28', hasAcceptedData: true }),
      period(1, { pnlLatestDataDate: '2026-02-28', hasAcceptedData: true }),
      period(2, { pnlLatestDataDate: '2026-02-28', hasAcceptedData: true }),
      period(3, { pnlLatestDataDate: '2026-02-28', hasAcceptedData: true }),
    ];
    const latest = latestCompletePeriod({ hasActiveCashLikeAccount: false, periods });
    expect(latest?.periodId).toBe('p-2026-02');
    expect(latest?.status).toBe('complete');
    // The very same coverage, for an organisation that does hold a cash account, is not complete.
    expect(latestCompletePeriod({ hasActiveCashLikeAccount: true, periods })?.status).toBe('partial');
  });

  /**
   * Pattern 3 — mid-month upload, nothing complete yet.
   *
   * The only export declares 1–14 February, so no period's P&L source reaches a period end. The
   * fallback returns the latest period holding accepted data, flagged `partial`; the surfaces then
   * show "February so far" (ADR-030.1).
   */
  it('falls back to the latest period with accepted data, flagged partial', () => {
    const latest = latestCompletePeriod({
      hasActiveCashLikeAccount: true,
      periods: [
        period(0, {}),
        period(1, {}),
        period(2, {}),
        period(3, { pnlLatestDataDate: '2026-02-14', bankCoverage: 'full', hasAcceptedData: true }),
      ],
    });
    expect(latest?.periodId).toBe('p-2026-02');
    expect(latest?.status).toBe('partial');
    expect(monthName(latest!.period)).toBe('February');
  });

  it('prefers a complete month to a later partial one', () => {
    const latest = latestCompletePeriod({
      hasActiveCashLikeAccount: true,
      periods: [
        period(2, { pnlLatestDataDate: '2026-01-31', bankCoverage: 'full', hasAcceptedData: true }),
        period(3, { pnlLatestDataDate: '2026-02-14', bankCoverage: 'full', hasAcceptedData: true }),
      ],
    });
    expect(latest?.periodId).toBe('p-2026-01');
    expect(latest?.status).toBe('complete');
  });

  it('returns null for an organisation with no data at all, rather than guessing a month', () => {
    expect(latestCompletePeriod({ hasActiveCashLikeAccount: true, periods: [] })).toBeNull();
    expect(
      latestCompletePeriod({ hasActiveCashLikeAccount: true, periods: [period(0, {}), period(1, {})] }),
    ).toBeNull();
  });

  it('is unaffected by the order rows arrive in', () => {
    const rows = [
      period(3, { pnlLatestDataDate: '2026-01-31', bankCoverage: 'full', hasAcceptedData: true }),
      period(0, { pnlLatestDataDate: '2026-01-31', bankCoverage: 'full', hasAcceptedData: true }),
      period(2, { pnlLatestDataDate: '2026-01-31', bankCoverage: 'full', hasAcceptedData: true }),
      period(1, { pnlLatestDataDate: '2026-01-31', bankCoverage: 'full', hasAcceptedData: true }),
    ];
    expect(latestCompletePeriod({ hasActiveCashLikeAccount: true, periods: rows })?.periodId).toBe(
      'p-2026-01',
    );
  });

  describe('isPeriodComplete()', () => {
    it('needs the declared range to reach the period end, exactly (non-strict)', () => {
      expect(
        isPeriodComplete(
          period(2, { pnlLatestDataDate: '2026-01-31', bankCoverage: 'full' }),
          true,
        ),
      ).toBe(true);
      expect(
        isPeriodComplete(
          period(2, { pnlLatestDataDate: '2026-01-30', bankCoverage: 'full' }),
          true,
        ),
      ).toBe(false);
      // A range that runs past the period end still covers it.
      expect(
        isPeriodComplete(
          period(2, { pnlLatestDataDate: '2026-03-31', bankCoverage: 'full' }),
          true,
        ),
      ).toBe(true);
    });

    it('is false when no P&L source covers the period, whatever the bank says', () => {
      expect(isPeriodComplete(period(2, { pnlLatestDataDate: null, bankCoverage: 'full' }), true)).toBe(
        false,
      );
    });

    it('rejects a period row that is not exactly one calendar month', () => {
      expect(() =>
        isPeriodComplete(
          {
            periodId: 'p-quarter',
            periodStart: '2026-01-01',
            periodEnd: '2026-03-31',
            pnlLatestDataDate: '2026-03-31',
            bankCoverage: 'full',
            hasAcceptedData: true,
          },
          false,
        ),
      ).toThrow(ValidationError);
    });
  });
});
