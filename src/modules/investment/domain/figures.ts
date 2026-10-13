/**
 * Every number in the Investment Pack (ADR-171): APX's own arithmetic on the company's own figures.
 *
 * The client's example ("Investment Strategy & Financial Growth Plan — Investment Pack", October
 * 2026) is a set of illustrations built on one starting year: £1,000,000 of revenue at a 15% net
 * margin grows at 20%, 35% and 50% a year (Year 5: £2,073,600 / £311,040, £3,321,506 / £498,226,
 * £5,062,500 / £759,375); a £100,000 distributable surplus is split 45 / 35 / 20 between business
 * growth, external investments and additional liquidity; the external share is spread across asset
 * classes (£35,000 → £15,750 / £8,750 / £7,000 / £1,750 / £1,750); and money compounds at 4%, 10%
 * and 15% for five years (£100,000 → £121,665, £161,051, £201,136). This file produces exactly those
 * tables, with the company's latest year in place of the example's £1m — so that ChatGPT, which
 * writes the words (`InvestmentNarrative`), never has a figure of its own to state.
 *
 * The rules, and why:
 *
 *   - THE BASE YEAR is the latest financial year whose turnover AND net profit are both known, from
 *     the same three-year overview Marketing's Section 03 shows (ADR-170, `MarketingFinancials.years`)
 *     — so the two departments can never start from different figures. A year still in progress is
 *     ANNUALISED (× 12 ÷ the months it holds) and says so in its label; the months held are the
 *     months whose figures are in the totals, never months nobody can state (FINANCIAL_ENGINE.md
 *     §1.5: never zero-fill).
 *   - Year 1 of every projection IS the base year; each later year grows by the scenario's rate, and
 *     net profit stays at the base year's net margin (the client's "constant 15% net profit margin").
 *     Year 5 therefore follows four growth periods, as the client's own note says.
 *   - THE SURPLUS is the analyst's amount when one is entered, else the base year's net profit when
 *     that is positive; with neither there is nothing to allocate and there are no figures (null).
 *   - Returns compound annually on the external allocation with no withdrawals, before fees, taxes and
 *     inflation (the client's wording).
 *   - Displayed money is rounded to WHOLE currency units, ROUND_HALF_UP, once (the client's tables
 *     show whole pounds; ADR-006 rounds once). Intermediate values keep the full twenty significant
 *     digits: Year 5 is base × (1 + g)⁴, not four rounded steps. Money leaves as a two-place decimal
 *     string like every money value in APX (ADR-006) — "2073600.00" — whole units with ".00".
 *   - Amounts that are SHARES of a whole (the surplus split, the portfolio) add up exactly to that
 *     whole: largest-remainder rounding, so a table's total row is never a pound out.
 *   - Anything derived from a rounded figure on the page is derived from the ROUNDED figure: the
 *     return scenarios start from the external allocation as shown, and a gain is the shown final value
 *     less the shown start, so every row of every table adds up as printed.
 *
 * Pure: no I/O, no clock, no AI. `services/figures.ts` loads the base year.
 */

import { ValidationError } from '@/core/errors';
import {
  Decimal,
  PERCENT_DISPLAY_DECIMAL_PLACES,
  ROUND_HALF_UP,
  ZERO,
  parseDecimal,
  toMoneyString,
} from '@/core/money';
import { monthsBetween, parseIsoDate, periodLabelLong, yearMonthOf } from '@/core/periods';
import type { FinancialYear } from '@/modules/marketing';
import type {
  Amount,
  GrowthScenario,
  InvestmentAssumptions,
  InvestmentBase,
  InvestmentFigures,
  PortfolioShare,
  ProjectionYear,
  ReinvestComparison,
  ReturnScenario,
  SurplusSource,
} from './types';

// ---------------------------------------------------------------------------------------------
// The client's assumptions
// ---------------------------------------------------------------------------------------------

/** The assumptions other than the surplus, which comes from the company or the analyst, never a default. */
export type AssumptionDefaults = Omit<InvestmentAssumptions, 'surplus' | 'surplusSource'>;

/**
 * The client's own example: 20% base, 35% acceleration and 50% stretch growth; a 10% illustrative
 * long-term return target; the surplus split 45 / 35 / 20; return scenarios at 4%, 10% and 15%; five
 * years. Frozen: a caller that wants different assumptions passes them, it never edits these.
 */
export const DEFAULT_ASSUMPTIONS: AssumptionDefaults = Object.freeze({
  growthRates: Object.freeze(['20', '35', '50'] as const),
  targetReturnPct: '10',
  split: Object.freeze({ business: '45', external: '35', liquidity: '20' }),
  returnRates: Object.freeze(['4', '10', '15'] as const),
  horizonYears: 5,
});

/** The SOW's comparison: the external allocation invested for three years at the target return. */
export const COMPARISON_YEARS = 3;

/** Longest horizon a pack projects; beyond it an "illustration" is a guess with a decimal point. */
export const MAX_HORIZON_YEARS = 30;

/** The names of the three growth scenarios, in the client's words and order. */
export const SCENARIO_NAMES = ['Base case', 'Acceleration case', 'Stretch case'] as const;

// ---------------------------------------------------------------------------------------------
// Small arithmetic
// ---------------------------------------------------------------------------------------------

const ONE = new Decimal(1);
const TWELVE = new Decimal(12);
const ONE_HUNDRED = new Decimal(100);
const PENNY = new Decimal('0.01');

/** Whole currency units, ROUND_HALF_UP; never "−0". */
function whole(value: Decimal): Decimal {
  const rounded = value.toDecimalPlaces(0, ROUND_HALF_UP);
  return rounded.isZero() ? ZERO : rounded;
}

/** A displayed amount: whole units, as APX's two-place money string ("2073600.00"). */
const shown = (value: Decimal): string => toMoneyString(whole(value));

/** 1 + p/100 for a percentage string: the growth factor of one year. */
const factorOf = (pct: Decimal): Decimal => ONE.plus(pct.dividedBy(ONE_HUNDRED));

/** A ratio as a one-place percentage string, ROUND_HALF_UP once; never "-0.0" (as Marketing's Section 03). */
function percentString(ratio: Decimal): string {
  const percent = ratio.times(ONE_HUNDRED).toDecimalPlaces(PERCENT_DISPLAY_DECIMAL_PLACES, ROUND_HALF_UP);
  return (percent.isZero() ? ZERO : percent).toFixed(PERCENT_DISPLAY_DECIMAL_PLACES);
}

/**
 * Split `total` into shares proportional to `weights`, adding up EXACTLY to `total` (largest
 * remainder). The unit is a whole currency unit when the total is whole, which every amount this
 * file allocates is; a total with pence is split in pence rather than lose them. Each share is first
 * rounded down; the units left over go one at a time to the shares that lost the most, the earlier
 * share first on a tie, so the result never depends on anything but the inputs' order.
 */
function largestRemainder(total: Decimal, weights: readonly Decimal[]): Decimal[] {
  if (weights.length === 0) return [];
  const unit = total.isInteger() ? ONE : PENNY;
  const units = total.dividedBy(unit).toDecimalPlaces(0, ROUND_HALF_UP);
  const weightTotal = weights.reduce((acc, w) => acc.plus(w), ZERO);
  if (!weightTotal.greaterThan(0)) return weights.map(() => ZERO);

  const exact = weights.map((w) => units.times(w).dividedBy(weightTotal));
  const counts = exact.map((e) => e.floor());
  // Fewer units are left over than there are shares: each share lost less than one.
  let left = units.minus(counts.reduce((acc, c) => acc.plus(c), ZERO));
  const order = exact
    .map((e, index) => ({ index, remainder: e.minus(e.floor()) }))
    .sort((a, b) => b.remainder.comparedTo(a.remainder) || a.index - b.index);
  for (const { index } of order) {
    if (!left.greaterThan(0)) break;
    counts[index] = counts[index]!.plus(ONE);
    left = left.minus(ONE);
  }
  return counts.map((c) => (c.isZero() ? ZERO : c.times(unit)));
}

// ---------------------------------------------------------------------------------------------
// The base year
// ---------------------------------------------------------------------------------------------

const MONTH_COUNT_IN_LABEL = /\((\d{1,2}) months?\b/;

/**
 * The months whose figures are in a year's totals.
 *
 * A whole year is twelve. A partial year is counted from its first month to its last
 * (`periodStart`..`periodEnd`, which `MarketingFinancials` sets to the months its figures cover) —
 * unless the year's own label says it holds FEWER ("2026 (5 months)" across six calendar months):
 * Section 03 leaves out a month nobody can state, and dividing five months' totals by six would
 * quietly read the missing month as a zero (FINANCIAL_ENGINE.md §1.5).
 */
export function monthsHeld(year: FinancialYear): number {
  if (!year.partial) return 12;
  const span = monthsBetween(yearMonthOf(year.periodStart), yearMonthOf(year.periodEnd)) + 1;
  const stated = MONTH_COUNT_IN_LABEL.exec(year.label);
  const count = stated ? Number(stated[1]) : span;
  return Math.max(1, Math.min(12, count > 0 && count < span ? count : span));
}

/** "2026" from "2026", "2026 (9 months)" or "2026 (to Sep)": the year's name without its qualifier. */
function yearName(label: string): string {
  const name = label.replace(/\s*\(.*\)\s*$/, '').trim();
  return name.length > 0 ? name : label;
}

export interface BaseYear {
  /** The year the pack starts from, as Section 03 states it. */
  readonly year: FinancialYear;
  /** True when it is not the latest year Section 03 shows (the latest lacks turnover or net profit). */
  readonly skippedLatest: boolean;
  /** The months whose figures are in its totals. */
  readonly months: number;
  /** True when those are fewer than twelve and the figures are scaled to a full year. */
  readonly annualised: boolean;
  /** "2026", or "2026 (9 months, annualised)". */
  readonly label: string;
}

/**
 * The latest year whose turnover and net profit are both known — a year missing either cannot start
 * a projection of both, so the year before it does. Null when no year has both.
 */
export function baseYearOf(years: readonly FinancialYear[]): BaseYear | null {
  for (let i = years.length - 1; i >= 0; i -= 1) {
    const year = years[i]!;
    if (year.turnover === null || year.netProfit === null) continue;
    const months = monthsHeld(year);
    const annualised = months < 12;
    const name = yearName(year.label);
    return {
      year,
      skippedLatest: i < years.length - 1,
      months,
      annualised,
      label: annualised ? `${name} (${months} ${months === 1 ? 'month' : 'months'}, annualised)` : name,
    };
  }
  return null;
}

/**
 * The starting point of every projection: the base year's turnover and net profit for a full year,
 * and the net margin between them. Null when no year has both figures, and when the base year's
 * turnover is not positive — a margin on no sales (or on a net refund) is not a margin anyone can
 * project, and an older year would be a stale starting point presented as the current one.
 *
 * Revenue and net profit keep pence (they are inputs, not displayed totals); the margin is one
 * decimal place, from the year's own totals (annualising scales both sides alike).
 */
export function baseFromYears(
  years: readonly FinancialYear[], currency: string, sourceNote: string,
): InvestmentBase | null {
  const base = baseYearOf(years);
  if (base === null) return null;
  const turnover = parseDecimal(base.year.turnover!, 'turnover');
  const netProfit = parseDecimal(base.year.netProfit!, 'netProfit');
  if (!turnover.greaterThan(0)) return null;
  const annualise = (value: Decimal) => (base.annualised ? value.times(TWELVE).dividedBy(base.months) : value);
  return {
    currency,
    yearLabel: base.label,
    revenue: toMoneyString(annualise(turnover)),
    netProfit: toMoneyString(annualise(netProfit)),
    netMarginPct: percentString(netProfit.dividedBy(turnover)),
    annualised: base.annualised,
    sourceNote,
  };
}

/**
 * The surplus APX allocates by default: the base year's net profit, in whole units, when it is
 * positive; null when the year made no profit (the analyst must then enter an amount). Whole units
 * because the surplus is a displayed total that the split must add up to exactly.
 */
export function defaultSurplus(base: InvestmentBase): string | null {
  const surplus = whole(parseDecimal(base.netProfit, 'netProfit'));
  return surplus.greaterThan(0) ? toMoneyString(surplus) : null;
}

// ---------------------------------------------------------------------------------------------
// The source note
// ---------------------------------------------------------------------------------------------

const NUMBER_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** "30 September 2026". */
function longDate(iso: string): string {
  const { year, month, day } = parseIsoDate(iso);
  return `${day} ${periodLabelLong({ year, month })}`;
}

const SOURCE_SENTENCE = /Source: [^.]*\./;
const FALLBACK_SOURCE =
  "Source: the company's own records in APX — the monthly profit and loss figures APX calculated, added together for the year.";

/**
 * The note under the pack's figures, in the style of Section 03's: which year they start from (and,
 * for a year in progress, that it was scaled to twelve months and from which months), the currency
 * and the source. The "Source: …" sentence is Section 03's own when its note carries one — it names
 * what the figures were calculated from (accounts, bank statements …) — so the two departments
 * describe the same figures in the same words. Null when there is no base year.
 */
export function investmentSourceNote(
  years: readonly FinancialYear[], currency: string, marketingNote: string | null,
): string | null {
  const base = baseYearOf(years);
  if (base === null) return null;
  const { year, months } = base;
  const name = yearName(year.label);
  const sentences = [
    base.annualised
      ? `${name} (${months} ${months === 1 ? 'month' : 'months'}, annualised to twelve): the ${NUMBER_WORDS[months]} `
        + `${months === 1 ? 'month' : 'months'} of figures from ${longDate(year.periodStart)} to ${longDate(year.periodEnd)}, `
        + 'with turnover and net profit scaled up to a full year.'
      : `${name}: the financial year ended ${longDate(year.periodEnd)}.`,
  ];
  if (base.skippedLatest) {
    sentences.push(`The latest year, ${years[years.length - 1]!.label}, is not used: its turnover or net profit is not known for every month.`);
  }
  sentences.push(`All figures ${currency}.`);
  sentences.push(marketingNote?.match(SOURCE_SENTENCE)?.[0] ?? FALLBACK_SOURCE);
  sentences.push('Net profit is after interest and any tax recorded in the accounts.');
  return sentences.join(' ');
}

// ---------------------------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------------------------

type Issue = { path: string; message: string };

/** A percentage the pack can use: readable, and above −100% (a fall of everything or more is no rate). */
function rateOf(value: string, path: string, issues: Issue[], minimum: 'above_minus_100' | 'not_negative'): Decimal | null {
  let parsed: Decimal;
  try {
    parsed = parseDecimal(value, path);
  } catch {
    issues.push({ path, message: `"${value}" is not a percentage.` });
    return null;
  }
  if (minimum === 'above_minus_100' && !parsed.greaterThan(-100)) {
    issues.push({ path, message: 'A rate must be above −100%.' });
    return null;
  }
  if (minimum === 'not_negative' && parsed.lessThan(0)) {
    issues.push({ path, message: 'A share cannot be negative.' });
    return null;
  }
  return parsed;
}

interface Resolved {
  readonly growth: readonly [Decimal, Decimal, Decimal];
  readonly target: Decimal;
  readonly split: readonly [Decimal, Decimal, Decimal];
  readonly returns: readonly [Decimal, Decimal, Decimal];
  readonly horizon: number;
  /** The assumptions as stated, normalised ("20.0" → "20"). */
  readonly stated: AssumptionDefaults;
}

/**
 * The defaults with the caller's overrides, checked. A rate APX cannot use, a split that does not
 * add up to 100 or a horizon outside 1–30 years is a mistake in the request, raised rather than
 * projected (a pack built on it would be a confident wrong answer).
 */
function resolveAssumptions(overrides: Partial<InvestmentAssumptions> | undefined): Resolved {
  const merged = { ...DEFAULT_ASSUMPTIONS, ...stripSurplus(overrides) };
  const issues: Issue[] = [];
  const three = (values: readonly string[], path: string): [Decimal, Decimal, Decimal] | null => {
    if (values.length !== 3) {
      issues.push({ path, message: 'Exactly three rates are needed.' });
      return null;
    }
    const parsed = values.map((v, i) => rateOf(v, `${path}[${i}]`, issues, 'above_minus_100'));
    return parsed.every((p): p is Decimal => p !== null) ? [parsed[0]!, parsed[1]!, parsed[2]!] : null;
  };

  const growth = three(merged.growthRates, 'growthRates');
  const returns = three(merged.returnRates, 'returnRates');
  const target = rateOf(merged.targetReturnPct, 'targetReturnPct', issues, 'above_minus_100');
  const business = rateOf(merged.split.business, 'split.business', issues, 'not_negative');
  const external = rateOf(merged.split.external, 'split.external', issues, 'not_negative');
  const liquidity = rateOf(merged.split.liquidity, 'split.liquidity', issues, 'not_negative');
  if (business && external && liquidity && !business.plus(external).plus(liquidity).equals(ONE_HUNDRED)) {
    issues.push({ path: 'split', message: 'The split must add up to 100%.' });
  }
  const horizon = merged.horizonYears;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > MAX_HORIZON_YEARS) {
    issues.push({ path: 'horizonYears', message: `The horizon must be a whole number of years from 1 to ${MAX_HORIZON_YEARS}.` });
  }
  if (issues.length > 0 || !growth || !returns || !target || !business || !external || !liquidity) {
    throw new ValidationError('The investment assumptions need fixing.', issues);
  }

  const text = (d: Decimal) => d.toString();
  return {
    growth,
    target,
    split: [business, external, liquidity],
    returns,
    horizon,
    stated: {
      growthRates: [text(growth[0]), text(growth[1]), text(growth[2])],
      targetReturnPct: text(target),
      split: { business: text(business), external: text(external), liquidity: text(liquidity) },
      returnRates: [text(returns[0]), text(returns[1]), text(returns[2])],
      horizonYears: horizon,
    },
  };
}

/**
 * `surplus` and `surplusSource` are not assumptions a caller can set through `assumptions`: the
 * surplus is the analyst's (`options.surplus`) or the company's, and its source says which. Taking
 * them from here would let a stored `surplusSource: 'net_profit'` label an amount nobody checked.
 */
function stripSurplus(overrides: Partial<InvestmentAssumptions> | undefined): Partial<AssumptionDefaults> {
  if (overrides === undefined) return {};
  const { surplus: _surplus, surplusSource: _source, ...rest } = overrides;
  return rest;
}

// ---------------------------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------------------------

/**
 * One growth path (the client's table): Year 1 is the base year's revenue and net profit; each later
 * year is the year before × (1 + g); net profit is held at the base year's net margin — computed as
 * base net profit × (1 + g)ⁿ, which is the same thing without a rounded margin in between.
 */
export function growthScenario(base: InvestmentBase, growthPct: string, name: string, horizonYears: number): GrowthScenario {
  const factor = factorOf(parseDecimal(growthPct, 'growthPct'));
  const revenue = parseDecimal(base.revenue, 'revenue');
  const netProfit = parseDecimal(base.netProfit, 'netProfit');
  const years: ProjectionYear[] = [];
  for (let i = 0; i < horizonYears; i += 1) {
    const growth = factor.pow(i);
    years.push({ label: `Year ${i + 1}`, revenue: shown(revenue.times(growth)), netProfit: shown(netProfit.times(growth)) });
  }
  return { growthPct, name, years };
}

/**
 * Money compounding annually at `ratePct` with no withdrawals: the value at the end of each year,
 * the final value, and the gain — the final value AS SHOWN less the start, so the row adds up. The
 * start is used as given (the external allocation is already whole units).
 */
export function returnScenario(startAmount: string, ratePct: string, years: number): ReturnScenario {
  const start = parseDecimal(startAmount, 'startAmount');
  const factor = factorOf(parseDecimal(ratePct, 'ratePct'));
  const values: string[] = [];
  for (let i = 1; i <= years; i += 1) values.push(shown(start.times(factor.pow(i))));
  const finalValue = values[values.length - 1] ?? toMoneyString(start);
  return {
    ratePct,
    startAmount: toMoneyString(start),
    values,
    finalValue,
    gain: toMoneyString(parseDecimal(finalValue).minus(start)),
  };
}

/**
 * The SOW's comparison: the external allocation invested for three years at the target return, and
 * the extra sales the business would need, at its base-year net margin, to earn the same gain as net
 * profit (gain ÷ margin). The margin is the exact ratio, not the one-place percentage shown; there is
 * no such figure (null) when the business makes no margin to earn it from.
 */
export function reinvestComparison(base: InvestmentBase, amount: string, targetReturnPct: string): ReinvestComparison {
  const scenario = returnScenario(amount, targetReturnPct, COMPARISON_YEARS);
  const revenue = parseDecimal(base.revenue, 'revenue');
  const netProfit = parseDecimal(base.netProfit, 'netProfit');
  const marginPositive = revenue.greaterThan(0) && netProfit.greaterThan(0);
  return {
    years: COMPARISON_YEARS,
    ratePct: targetReturnPct,
    amount: scenario.startAmount,
    value: scenario.finalValue,
    gain: scenario.gain,
    salesNeededForSameGain: marginPositive
      ? shown(parseDecimal(scenario.gain).times(revenue).dividedBy(netProfit))
      : null,
  };
}

// ---------------------------------------------------------------------------------------------
// The pack's figures
// ---------------------------------------------------------------------------------------------

export interface BuildOptions {
  /** The analyst's distributable surplus; null, absent or blank for the base year's net profit. */
  readonly surplus?: string | null;
  /** Overrides of the client's assumptions (`surplus` and `surplusSource` here are ignored). */
  readonly assumptions?: Partial<InvestmentAssumptions>;
}

/**
 * Every figure in the pack from the base year: the surplus and its split, the base case and the three
 * growth scenarios, the three return scenarios on the external allocation, and the three-year
 * comparison. Null when there is no positive surplus to allocate (no analyst amount, and the base
 * year made no profit; or an analyst amount that is not above zero in whole units).
 *
 * Throws `ValidationError` for an analyst amount that is not a number and for assumptions APX cannot
 * use (see `resolveAssumptions`).
 */
export function buildInvestmentFigures(base: InvestmentBase, options: BuildOptions = {}): InvestmentFigures | null {
  const assumptions = resolveAssumptions(options.assumptions);

  const entered = options.surplus?.trim() ?? '';
  const surplusSource: SurplusSource = entered.length > 0 ? 'analyst' : 'net_profit';
  const surplusText = entered.length > 0 ? entered : defaultSurplus(base);
  if (surplusText === null) return null;
  const surplus = whole(parseDecimal(surplusText, 'surplus'));
  if (!surplus.greaterThan(0)) return null;

  const [business, external, liquidity] = largestRemainder(surplus, assumptions.split);
  const amount = (percent: string, value: Decimal): Amount => ({ percent, amount: toMoneyString(value) });
  const allocation = {
    business: amount(assumptions.stated.split.business, business!),
    external: amount(assumptions.stated.split.external, external!),
    liquidity: amount(assumptions.stated.split.liquidity, liquidity!),
  };

  const horizon = assumptions.horizon;
  const growthRates = assumptions.stated.growthRates;
  const growthScenarios = [
    growthScenario(base, growthRates[0], SCENARIO_NAMES[0], horizon),
    growthScenario(base, growthRates[1], SCENARIO_NAMES[1], horizon),
    growthScenario(base, growthRates[2], SCENARIO_NAMES[2], horizon),
  ] as const;

  const returnRates = assumptions.stated.returnRates;
  const start = allocation.external.amount;
  const returnScenarios = [
    returnScenario(start, returnRates[0], horizon),
    returnScenario(start, returnRates[1], horizon),
    returnScenario(start, returnRates[2], horizon),
  ] as const;

  return {
    base,
    assumptions: { ...assumptions.stated, surplus: toMoneyString(surplus), surplusSource },
    allocation,
    baseCase: growthScenarios[0],
    growthScenarios,
    returnScenarios,
    comparison: reinvestComparison(base, start, assumptions.stated.targetReturnPct),
  };
}

/**
 * The narrative's portfolio (asset classes and whole-percent shares) applied to the external
 * allocation: amounts that add up exactly to `external` (largest remainder, whole units). The shares
 * must add up to 100 — the portfolio table's TOTAL row says 100% — and none may be negative; anything
 * else is a narrative the schema should have refused, raised here rather than quietly rescaled.
 */
export function allocatePortfolio(
  external: string, shares: readonly PortfolioShare[],
): (PortfolioShare & { amount: string })[] {
  const total = parseDecimal(external, 'external');
  const issues: Issue[] = [];
  if (total.lessThan(0)) issues.push({ path: 'external', message: 'The external allocation cannot be negative.' });
  const weights = shares.map((share, i) => rateOf(share.percent, `portfolio[${i}].percent`, issues, 'not_negative'));
  if (shares.length > 0 && weights.every((w) => w !== null)) {
    const sum = weights.reduce<Decimal>((acc, w) => acc.plus(w!), ZERO);
    if (!sum.equals(ONE_HUNDRED)) issues.push({ path: 'portfolio', message: `The shares add up to ${sum.toString()}%, not 100%.` });
  }
  if (issues.length > 0) throw new ValidationError('The portfolio cannot be allocated.', issues);

  const amounts = largestRemainder(total, weights as Decimal[]);
  return shares.map((share, i) => ({ ...share, amount: toMoneyString(amounts[i]!) }));
}
