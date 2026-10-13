import type { GrowthScenario, InvestmentFigures, ReturnScenario } from '@/modules/investment';

/**
 * ADR-171 fixture: the client's own example pack (the "Investment Strategy & Financial Growth Plan",
 * October 2026) as `InvestmentFigures`, written out BY HAND — £1,000,000 revenue, a 15% net margin, a
 * £100,000 distributable surplus entered by the analyst, split 45/35/20, growth at 20/35/50% and
 * returns at 4/10/15% — so the narrative's tests do not depend on APX's figures builder
 * (`domain/figures.ts`, tested on its own). Amounts are whole units, as the builder shows them.
 *
 * Two departures from the client's document, both the contract's: the return scenarios run on the
 * £35,000 external allocation (the document illustrates £100,000), and the comparison is the SOW's —
 * £35,000 for three years at 10% (a gain of £11,585), against the £77,233 of sales the business would
 * need at a 15% margin to earn the same.
 */

const years = (rows: ReadonlyArray<readonly [string, string]>) =>
  rows.map(([revenue, netProfit], i) => ({ label: `Year ${i + 1}`, revenue, netProfit }));

const BASE_CASE: GrowthScenario = {
  growthPct: '20',
  name: 'Base case',
  years: years([
    ['1000000.00', '150000.00'], ['1200000.00', '180000.00'], ['1440000.00', '216000.00'],
    ['1728000.00', '259200.00'], ['2073600.00', '311040.00'],
  ]),
};

const ACCELERATION: GrowthScenario = {
  growthPct: '35',
  name: 'Acceleration case',
  years: years([
    ['1000000.00', '150000.00'], ['1350000.00', '202500.00'], ['1822500.00', '273375.00'],
    ['2460375.00', '369056.00'], ['3321506.00', '498226.00'],
  ]),
};

const STRETCH: GrowthScenario = {
  growthPct: '50',
  name: 'Stretch case',
  years: years([
    ['1000000.00', '150000.00'], ['1500000.00', '225000.00'], ['2250000.00', '337500.00'],
    ['3375000.00', '506250.00'], ['5062500.00', '759375.00'],
  ]),
};

const returns = (ratePct: string, values: readonly string[], gain: string): ReturnScenario => ({
  ratePct, startAmount: '35000.00', values, finalValue: values[values.length - 1]!, gain,
});

export const CLIENT_FIGURES: InvestmentFigures = {
  base: {
    currency: 'GBP',
    yearLabel: '2026',
    revenue: '1000000.00',
    netProfit: '150000.00',
    netMarginPct: '15.0',
    annualised: false,
    sourceNote: 'Financial year ended 30 September 2026. Source: the accounts held in APX.',
  },
  assumptions: {
    surplus: '100000.00',
    surplusSource: 'analyst',
    growthRates: ['20', '35', '50'],
    targetReturnPct: '10',
    split: { business: '45', external: '35', liquidity: '20' },
    returnRates: ['4', '10', '15'],
    horizonYears: 5,
  },
  allocation: {
    business: { percent: '45', amount: '45000.00' },
    external: { percent: '35', amount: '35000.00' },
    liquidity: { percent: '20', amount: '20000.00' },
  },
  baseCase: BASE_CASE,
  growthScenarios: [BASE_CASE, ACCELERATION, STRETCH],
  returnScenarios: [
    returns('4', ['36400.00', '37856.00', '39370.00', '40945.00', '42583.00'], '7583.00'),
    returns('10', ['38500.00', '42350.00', '46585.00', '51244.00', '56368.00'], '21368.00'),
    returns('15', ['40250.00', '46288.00', '53231.00', '61215.00', '70398.00'], '35398.00'),
  ],
  comparison: {
    years: 3,
    ratePct: '10',
    amount: '35000.00',
    value: '46585.00',
    gain: '11585.00',
    salesNeededForSameGain: '77233.00',
  },
};

/** The same figures in another currency (the amounts unchanged): for the currency-aware checks. */
export function figuresIn(currency: string): InvestmentFigures {
  return { ...CLIENT_FIGURES, base: { ...CLIENT_FIGURES.base, currency } };
}
