import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/core/errors';
import { sum } from '@/core/money';
import type { FinancialYear } from '@/modules/marketing';
/*
 * Relative imports: the Investment barrel (`@/modules/investment`) is written alongside this feature,
 * and `motion/no-deep-module-import` (correctly) refuses `@/modules/investment/domain/figures`.
 */
import {
  DEFAULT_ASSUMPTIONS,
  allocatePortfolio,
  baseFromYears,
  baseYearOf,
  buildInvestmentFigures,
  defaultSurplus,
  growthScenario,
  investmentSourceNote,
  monthsHeld,
  reinvestComparison,
  returnScenario,
} from '../../src/modules/investment/domain/figures';
import type { InvestmentBase, PortfolioShare } from '../../src/modules/investment/domain/types';

/**
 * The Investment Pack's figures (ADR-171). The first block reproduces the client's own example
 * ("Investment Strategy & Financial Growth Plan — Investment Pack") figure for figure; the rest pin
 * the rules the example does not exercise: annualising a year in progress, a year without profit, the
 * analyst's surplus, rounding that adds up, and the three-year comparison. Every expected figure is
 * worked by hand beside the fixture that produces it.
 */

/** A Section 03 column (ADR-170) with only what the Investment Pack reads filled in. */
function fy(
  label: string, periodStart: string, periodEnd: string, turnover: string | null, netProfit: string | null, partial = false,
): FinancialYear {
  return {
    label, periodStart, periodEnd, partial, turnover, netProfit,
    costOfSales: null, costOfSalesPct: null, grossProfit: null, grossProfitPct: null, adminCosts: null,
    netProfitPct: null, marketingSpend: null, marketingPct: null,
  };
}

/** The client's starting year: £1,000,000 of revenue at a 15% net margin. */
const CLIENT_YEAR = fy('2025', '2024-10-01', '2025-09-30', '1000000.00', '150000.00');
const clientBase = (): InvestmentBase => baseFromYears([CLIENT_YEAR], 'GBP', 'note')!;

/** The client's portfolio of the £35,000 external allocation. */
const CLIENT_PORTFOLIO: PortfolioShare[] = [
  { assetClass: 'Global equity funds', percent: '45', risk: 'higher' },
  { assetClass: 'Investment-grade bond funds', percent: '25', risk: 'low_medium' },
  { assetClass: 'Cash and gilts', percent: '20', risk: 'lower' },
  { assetClass: 'Growth shares / sector ETFs', percent: '5', risk: 'high' },
  { assetClass: 'Private investments', percent: '5', risk: 'very_high' },
];

const year5 = (scenario: { years: readonly { revenue: string; netProfit: string }[] }) => scenario.years[4];

describe('the client\'s example, figure for figure', () => {
  it('starts from £1,000,000 of revenue at a 15.0% net margin', () => {
    expect(clientBase()).toEqual({
      currency: 'GBP', yearLabel: '2025', revenue: '1000000.00', netProfit: '150000.00', netMarginPct: '15.0',
      annualised: false, sourceNote: 'note',
    });
  });

  it('01 — the base case: Year 1 is the base year, then four growth periods at 20%', () => {
    const figures = buildInvestmentFigures(clientBase(), { surplus: '100000' })!;
    expect(figures.baseCase).toEqual({
      growthPct: '20',
      name: 'Base case',
      years: [
        { label: 'Year 1', revenue: '1000000.00', netProfit: '150000.00' },
        { label: 'Year 2', revenue: '1200000.00', netProfit: '180000.00' },
        { label: 'Year 3', revenue: '1440000.00', netProfit: '216000.00' },
        { label: 'Year 4', revenue: '1728000.00', netProfit: '259200.00' },
        { label: 'Year 5', revenue: '2073600.00', netProfit: '311040.00' },
      ],
    });
  });

  it('02 — Year 5 at 20%, 35% and 50% growth: £2,073,600 / £311,040, £3,321,506 / £498,226, £5,062,500 / £759,375', () => {
    const [base, acceleration, stretch] = buildInvestmentFigures(clientBase(), { surplus: '100000' })!.growthScenarios;
    expect([base.name, acceleration.name, stretch.name]).toEqual(['Base case', 'Acceleration case', 'Stretch case']);
    expect([base.growthPct, acceleration.growthPct, stretch.growthPct]).toEqual(['20', '35', '50']);
    expect(year5(base)).toEqual({ label: 'Year 5', revenue: '2073600.00', netProfit: '311040.00' });
    // 1,000,000 × 1.35⁴ = 3,321,506.25 → 3,321,506; 150,000 × 1.35⁴ = 498,225.9375 → 498,226.
    expect(year5(acceleration)).toEqual({ label: 'Year 5', revenue: '3321506.00', netProfit: '498226.00' });
    expect(year5(stretch)).toEqual({ label: 'Year 5', revenue: '5062500.00', netProfit: '759375.00' });
  });

  it('the executive allocation: £100,000 → £45,000 business, £35,000 external, £20,000 liquidity', () => {
    const figures = buildInvestmentFigures(clientBase(), { surplus: '100000' })!;
    expect(figures.assumptions.surplus).toBe('100000.00');
    expect(figures.assumptions.surplusSource).toBe('analyst');
    expect(figures.allocation).toEqual({
      business: { percent: '45', amount: '45000.00' },
      external: { percent: '35', amount: '35000.00' },
      liquidity: { percent: '20', amount: '20000.00' },
    });
  });

  it('the diversified portfolio of £35,000: £15,750 / £8,750 / £7,000 / £1,750 / £1,750', () => {
    const portfolio = allocatePortfolio('35000.00', CLIENT_PORTFOLIO);
    expect(portfolio.map((p) => p.amount)).toEqual(['15750.00', '8750.00', '7000.00', '1750.00', '1750.00']);
    expect(portfolio[0]).toEqual({ ...CLIENT_PORTFOLIO[0], amount: '15750.00' });
  });

  it('the return scenarios from £100,000: £121,665 / £161,051 / £201,136 after five years', () => {
    expect(returnScenario('100000.00', '4', 5)).toEqual({
      ratePct: '4', startAmount: '100000.00',
      // 104,000; 108,160; 112,486.40; 116,985.856; 121,665.29
      values: ['104000.00', '108160.00', '112486.00', '116986.00', '121665.00'],
      finalValue: '121665.00', gain: '21665.00',
    });
    expect(returnScenario('100000.00', '10', 5)).toMatchObject({ finalValue: '161051.00', gain: '61051.00' });
    // 100,000 × 1.15⁵ = 201,135.71875 → 201,136.
    expect(returnScenario('100000.00', '15', 5)).toMatchObject({ finalValue: '201136.00', gain: '101136.00' });
  });

  it('the same return table through the pack, with the whole surplus invested externally', () => {
    const figures = buildInvestmentFigures(clientBase(), {
      surplus: '100000', assumptions: { split: { business: '0', external: '100', liquidity: '0' } },
    })!;
    expect(figures.returnScenarios.map((s) => [s.ratePct, s.finalValue, s.gain])).toEqual([
      ['4', '121665.00', '21665.00'], ['10', '161051.00', '61051.00'], ['15', '201136.00', '101136.00'],
    ]);
  });

  it('in the pack, the return scenarios compound the £35,000 external allocation', () => {
    const [low, target, high] = buildInvestmentFigures(clientBase(), { surplus: '100000' })!.returnScenarios;
    expect(low.startAmount).toBe('35000.00');
    // 35,000 × 1.04ⁿ: 36,400; 37,856; 39,370.24; 40,945.0496; 42,582.851584
    expect(low.values).toEqual(['36400.00', '37856.00', '39370.00', '40945.00', '42583.00']);
    expect(low.gain).toBe('7583.00');
    expect(target.values).toEqual(['38500.00', '42350.00', '46585.00', '51244.00', '56368.00']);
    // 35,000 × 1.15⁵ = 70,397.5015625 → 70,398.
    expect(high).toMatchObject({ finalValue: '70398.00', gain: '35398.00' });
  });

  it('uses the client\'s assumptions by default', () => {
    expect(DEFAULT_ASSUMPTIONS).toEqual({
      growthRates: ['20', '35', '50'], targetReturnPct: '10',
      split: { business: '45', external: '35', liquidity: '20' }, returnRates: ['4', '10', '15'], horizonYears: 5,
    });
    expect(Object.isFrozen(DEFAULT_ASSUMPTIONS)).toBe(true);
    const figures = buildInvestmentFigures(clientBase())!;
    expect(figures.assumptions).toEqual({ ...DEFAULT_ASSUMPTIONS, surplus: '150000.00', surplusSource: 'net_profit' });
  });
});

describe('the base year', () => {
  it('annualises a year in progress (× 12 ÷ the months held) and says so in its label', () => {
    const years = [
      CLIENT_YEAR,
      // Nine months, October to June: 900,000 × 12 / 9 = 1,200,000; 135,000 × 12 / 9 = 180,000.
      fy('2026 (9 months)', '2025-10-01', '2026-06-30', '900000.00', '135000.00', true),
    ];
    expect(baseFromYears(years, 'GBP', 'n')).toEqual({
      currency: 'GBP', yearLabel: '2026 (9 months, annualised)', revenue: '1200000.00', netProfit: '180000.00',
      netMarginPct: '15.0', annualised: true, sourceNote: 'n',
    });
  });

  it('counts the months from the year\'s first month to its last', () => {
    expect(monthsHeld(fy('2026 (to Mar)', '2025-10-01', '2026-03-31', '1', '1', true))).toBe(6);
    expect(monthsHeld(fy('2026 (1 month)', '2025-10-01', '2025-10-31', '1', '1', true))).toBe(1);
    expect(monthsHeld(CLIENT_YEAR)).toBe(12);
  });

  it('divides by the months that have figures when a month inside the span has none (never zero-filled)', () => {
    // Five months of figures across January–June: dividing by six would read the missing month as nil.
    const gap = fy('2026 (5 months)', '2026-01-01', '2026-06-30', '500000.00', '50000.00', true);
    expect(monthsHeld(gap)).toBe(5);
    expect(baseFromYears([gap], 'GBP', 'n')).toMatchObject({
      yearLabel: '2026 (5 months, annualised)', revenue: '1200000.00', netProfit: '120000.00', annualised: true,
    });
  });

  it('keeps pence on the base year and uses the singular for one month', () => {
    // 100,000 × 12 / 7 = 171,428.5714… → 171,428.57.
    expect(baseFromYears([fy('2026 (7 months)', '2025-10-01', '2026-04-30', '100000.00', '10000.00', true)], 'GBP', 'n'))
      .toMatchObject({ revenue: '171428.57', netProfit: '17142.86', netMarginPct: '10.0' });
    expect(baseFromYears([fy('2026 (1 month)', '2025-10-01', '2025-10-31', '1000.00', '100.00', true)], 'GBP', 'n'))
      .toMatchObject({ yearLabel: '2026 (1 month, annualised)', revenue: '12000.00', netProfit: '1200.00' });
  });

  it('falls back to the year before when the latest lacks turnover or net profit', () => {
    const years = [CLIENT_YEAR, fy('2026 (3 months)', '2025-10-01', '2025-12-31', '300000.00', null, true)];
    expect(baseYearOf(years)).toMatchObject({ skippedLatest: true, annualised: false, label: '2025' });
    expect(baseFromYears(years, 'GBP', 'n')).toMatchObject({ yearLabel: '2025', revenue: '1000000.00' });
  });

  it('is null with no usable year, and when the base year\'s turnover is not positive', () => {
    expect(baseFromYears([], 'GBP', 'n')).toBeNull();
    expect(baseFromYears([fy('2025', '2024-10-01', '2025-09-30', null, '5.00')], 'GBP', 'n')).toBeNull();
    expect(baseFromYears([fy('2025', '2024-10-01', '2025-09-30', '0.00', '0.00')], 'GBP', 'n')).toBeNull();
    expect(baseFromYears([fy('2025', '2024-10-01', '2025-09-30', '-10.00', '-20.00')], 'GBP', 'n')).toBeNull();
  });

  it('states a loss-making year with its negative margin', () => {
    expect(baseFromYears([fy('2025', '2024-10-01', '2025-09-30', '200000.00', '-30000.00')], 'GBP', 'n'))
      .toMatchObject({ netProfit: '-30000.00', netMarginPct: '-15.0' });
  });
});

describe('the surplus', () => {
  const loss = () => baseFromYears([fy('2025', '2024-10-01', '2025-09-30', '200000.00', '-30000.00')], 'GBP', 'n')!;

  it('defaults to the base year\'s net profit, in whole units, when it is positive', () => {
    expect(defaultSurplus(clientBase())).toBe('150000.00');
    expect(defaultSurplus({ ...clientBase(), netProfit: '150000.50' })).toBe('150001.00');
    expect(defaultSurplus({ ...clientBase(), netProfit: '0.40' })).toBeNull();
    expect(defaultSurplus(loss())).toBeNull();
  });

  it('gives no figures when the year made no profit and the analyst entered nothing', () => {
    expect(buildInvestmentFigures(loss())).toBeNull();
    expect(buildInvestmentFigures(loss(), { surplus: null })).toBeNull();
    expect(buildInvestmentFigures(loss(), { surplus: '  ' })).toBeNull();
  });

  it('uses the analyst\'s amount when one is entered, even for a loss-making year', () => {
    const figures = buildInvestmentFigures(loss(), { surplus: '40000' })!;
    expect(figures.assumptions).toMatchObject({ surplus: '40000.00', surplusSource: 'analyst' });
    expect(figures.allocation.external.amount).toBe('14000.00');
    // The margin is held constant: −30,000 × 1.2⁴ = −62,208.
    expect(year5(figures.baseCase)).toEqual({ label: 'Year 5', revenue: '414720.00', netProfit: '-62208.00' });
    // No margin to earn the gain from.
    expect(figures.comparison.salesNeededForSameGain).toBeNull();
  });

  it('prefers the analyst\'s amount to the net profit, and rounds it to whole units', () => {
    const figures = buildInvestmentFigures(clientBase(), { surplus: '50000.50' })!;
    expect(figures.assumptions).toMatchObject({ surplus: '50001.00', surplusSource: 'analyst' });
    const { business, external, liquidity } = figures.allocation;
    expect(sum([business.amount, external.amount, liquidity.amount]).toFixed(2)).toBe('50001.00');
  });

  it('gives no figures for an amount that is not above zero, and refuses one that is not a number', () => {
    expect(buildInvestmentFigures(clientBase(), { surplus: '0' })).toBeNull();
    expect(buildInvestmentFigures(clientBase(), { surplus: '0.49' })).toBeNull();
    expect(buildInvestmentFigures(clientBase(), { surplus: '-500' })).toBeNull();
    expect(() => buildInvestmentFigures(clientBase(), { surplus: 'lots' })).toThrow(ValidationError);
  });

  it('splits an awkward surplus so the three parts add up exactly', () => {
    // 100,001 × 45/35/20 = 45,000.45 / 35,000.35 / 20,000.20: the spare pound goes to the largest remainder.
    const { allocation } = buildInvestmentFigures(clientBase(), { surplus: '100001' })!;
    expect([allocation.business.amount, allocation.external.amount, allocation.liquidity.amount])
      .toEqual(['45001.00', '35000.00', '20000.00']);
  });
});

describe('the portfolio', () => {
  const shares = (...percents: string[]): PortfolioShare[] =>
    percents.map((percent, i) => ({ assetClass: `Class ${i + 1}`, percent, risk: 'medium' }));

  it('adds up exactly to the external allocation, the spare units going to the largest remainders', () => {
    // 35,001 × 45/25/20/5/5 = 15,750.45 / 8,750.25 / 7,000.20 / 1,750.05 / 1,750.05.
    expect(allocatePortfolio('35001.00', CLIENT_PORTFOLIO).map((p) => p.amount))
      .toEqual(['15751.00', '8750.00', '7000.00', '1750.00', '1750.00']);
    // 10 × 33/33/34 = 3.3 / 3.3 / 3.4.
    expect(allocatePortfolio('10.00', shares('33', '33', '34')).map((p) => p.amount)).toEqual(['3.00', '3.00', '4.00']);
    // A tie goes to the earlier share.
    expect(allocatePortfolio('7.00', shares('50', '50')).map((p) => p.amount)).toEqual(['4.00', '3.00']);
  });

  it('always adds up, whatever the amount and the shares', () => {
    const splits = [shares('45', '25', '20', '5', '5'), shares('33', '33', '34'), shares('1', '1', '98'), shares('100'), shares('60', '0', '40')];
    for (const external of ['1.00', '7.00', '999.00', '12345.00', '35003.00', '9999999.00']) {
      for (const split of splits) {
        const amounts = allocatePortfolio(external, split).map((p) => p.amount);
        expect(sum(amounts).toFixed(2)).toBe(external);
        for (const amount of amounts) expect(amount).toMatch(/^\d+\.00$/);
      }
    }
  });

  it('splits in pence when the amount itself has pence', () => {
    expect(allocatePortfolio('100.05', shares('50', '50')).map((p) => p.amount)).toEqual(['50.03', '50.02']);
  });

  it('refuses shares that do not add up to 100, or are negative', () => {
    expect(() => allocatePortfolio('35000.00', shares('45', '25', '20'))).toThrow(ValidationError);
    expect(() => allocatePortfolio('35000.00', shares('110', '-10'))).toThrow(ValidationError);
    expect(() => allocatePortfolio('35000.00', shares('abc'))).toThrow(ValidationError);
    expect(allocatePortfolio('35000.00', [])).toEqual([]);
  });
});

describe('the three-year comparison', () => {
  it('invests the external allocation for three years at the target return, against the sales needed', () => {
    const { comparison } = buildInvestmentFigures(clientBase(), { surplus: '100000' })!;
    // 35,000 × 1.1³ = 46,585; gain 11,585; at a 15% margin, 11,585 / 0.15 = 77,233.33 of extra sales.
    expect(comparison).toEqual({
      years: 3, ratePct: '10', amount: '35000.00', value: '46585.00', gain: '11585.00', salesNeededForSameGain: '77233.00',
    });
  });

  it('divides by the exact margin, not the one-place percentage shown', () => {
    // 2,000 / 30,000 = 6.666…%, shown "6.7"; 3,310 × 30,000 / 2,000 = 49,650 (at 6.7% it would be 49,403).
    const base = baseFromYears([fy('2025', '2024-01-01', '2024-12-31', '30000.00', '2000.00')], 'GBP', 'n')!;
    expect(base.netMarginPct).toBe('6.7');
    expect(reinvestComparison(base, '10000.00', '10')).toEqual({
      years: 3, ratePct: '10', amount: '10000.00', value: '13310.00', gain: '3310.00', salesNeededForSameGain: '49650.00',
    });
  });

  it('has no sales figure when the business makes no margin', () => {
    const base = { ...clientBase(), netProfit: '0.00' };
    expect(reinvestComparison(base, '10000.00', '10').salesNeededForSameGain).toBeNull();
  });
});

describe('assumptions', () => {
  it('takes the caller\'s overrides and normalises them', () => {
    const figures = buildInvestmentFigures(clientBase(), {
      surplus: '100000', assumptions: { growthRates: ['10.0', '25', '40'], horizonYears: 3, targetReturnPct: '8' },
    })!;
    expect(figures.assumptions.growthRates).toEqual(['10', '25', '40']);
    expect(figures.baseCase.years.map((y) => y.revenue)).toEqual(['1000000.00', '1100000.00', '1210000.00']);
    expect(figures.returnScenarios[0].values).toHaveLength(3);
    expect(figures.comparison).toMatchObject({ years: 3, ratePct: '8' });
  });

  it('ignores a surplus passed as an assumption: the surplus is the analyst\'s or the company\'s', () => {
    const figures = buildInvestmentFigures(clientBase(), { assumptions: { surplus: '1', surplusSource: 'analyst' } })!;
    expect(figures.assumptions).toMatchObject({ surplus: '150000.00', surplusSource: 'net_profit' });
  });

  it('refuses a split that does not add up to 100, a rate of −100% or below, and an impossible horizon', () => {
    const build = (assumptions: Parameters<typeof buildInvestmentFigures>[1]) => () =>
      buildInvestmentFigures(clientBase(), { surplus: '100000', ...assumptions });
    expect(build({ assumptions: { split: { business: '50', external: '35', liquidity: '20' } } })).toThrow(ValidationError);
    expect(build({ assumptions: { split: { business: '120', external: '-20', liquidity: '0' } } })).toThrow(ValidationError);
    expect(build({ assumptions: { growthRates: ['20', '-100', '50'] } })).toThrow(ValidationError);
    expect(build({ assumptions: { returnRates: ['4', 'ten', '15'] } })).toThrow(ValidationError);
    expect(build({ assumptions: { horizonYears: 0 } })).toThrow(ValidationError);
    expect(build({ assumptions: { horizonYears: 2.5 } })).toThrow(ValidationError);
  });

  it('projects a single path on its own', () => {
    expect(growthScenario(clientBase(), '0', 'Flat', 2).years).toEqual([
      { label: 'Year 1', revenue: '1000000.00', netProfit: '150000.00' },
      { label: 'Year 2', revenue: '1000000.00', netProfit: '150000.00' },
    ]);
  });
});

describe('the source note', () => {
  const MARKETING_NOTE = 'Financial year ended 30 September 2025. All figures GBP. Source: the company\'s own records in APX — the '
    + 'monthly profit and loss figures APX calculated from its bank statements, added together for each financial year. '
    + 'Net profit is after interest and any tax recorded in the accounts.';

  it('names a whole year by its year-end, and borrows Section 03\'s source sentence', () => {
    expect(investmentSourceNote([CLIENT_YEAR], 'GBP', MARKETING_NOTE)).toBe(
      '2025: the financial year ended 30 September 2025. All figures GBP. Source: the company\'s own records in APX — the '
      + 'monthly profit and loss figures APX calculated from its bank statements, added together for each financial year. '
      + 'Net profit is after interest and any tax recorded in the accounts.',
    );
  });

  it('says which months an annualised year holds', () => {
    const note = investmentSourceNote(
      [fy('2026 (9 months)', '2025-10-01', '2026-06-30', '900000.00', '135000.00', true)], 'GBP', null,
    );
    expect(note).toBe(
      '2026 (9 months, annualised to twelve): the nine months of figures from 1 October 2025 to 30 June 2026, with turnover '
      + 'and net profit scaled up to a full year. All figures GBP. Source: the company\'s own records in APX — the monthly '
      + 'profit and loss figures APX calculated, added together for the year. Net profit is after interest and any tax '
      + 'recorded in the accounts.',
    );
  });

  it('says why the latest year is not the base year, and is null with no base year', () => {
    const years = [CLIENT_YEAR, fy('2026 (3 months)', '2025-10-01', '2025-12-31', null, null, true)];
    expect(investmentSourceNote(years, 'GBP', null))
      .toContain('The latest year, 2026 (3 months), is not used: its turnover or net profit is not known for every month.');
    expect(investmentSourceNote([], 'GBP', null)).toBeNull();
  });
});
