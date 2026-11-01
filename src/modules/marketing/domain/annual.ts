import { Decimal, ROUND_HALF_UP, formatMoney, parseDecimal } from '@/core/money';
import { yearMonthOf } from '@/core/periods';
import {
  buildMarketingFinancials, changePercent, financialYearOf, marketingFromAccounts,
  marketingSourceOf, monthHasFigures,
  type CampaignSpendFact, type CategorySpendFact, type MarketingSource, type MonthFacts,
} from './financials';
import type { FinancialYear } from './types';

/**
 * The department dashboard's year figures (ADR-180, the client's prototype): Key Report Indicators,
 * "How can I Grow?", Comparative Financials and Marketing vs Revenue.
 *
 * Every total is Marketing Section 03's own (`buildMarketingFinancials`), so the dashboard and the
 * Marketing report can never disagree. A year still in progress is compared with the SAME months of
 * the year before (like for like) — never nine months against twelve. Pure: Decimal throughout,
 * strings out.
 */

export interface AnnualFacts {
  readonly currency: string;
  readonly fiscalYearStartMonth: number;
  readonly months: readonly MonthFacts[];
  readonly categorySpend: readonly CategorySpendFact[];
  readonly campaignSpend: readonly CampaignSpendFact[];
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ymKey(periodStart: string): string {
  const { year, month } = yearMonthOf(periodStart);
  return `${year}-${String(month).padStart(2, '0')}`;
}
function yearEarlier(periodStart: string): string {
  const { year, month } = yearMonthOf(periodStart);
  return `${year - 1}-${String(month).padStart(2, '0')}`;
}
function monthName(periodStart: string): string {
  return MONTH_SHORT[yearMonthOf(periodStart).month - 1]!;
}

/** "Jan – Sep 2026", "Oct 2025 – Mar 2026", or the year alone for a whole financial year. */
export function spanLabel(months: readonly MonthFacts[], wholeYear: number | null): string {
  if (wholeYear !== null) return String(wholeYear);
  const first = months[0]!, last = months[months.length - 1]!;
  const fy = yearMonthOf(first.periodStart).year, ly = yearMonthOf(last.periodStart).year;
  if (months.length === 1) return `${monthName(first.periodStart)} ${fy}`;
  return fy === ly ? `${monthName(first.periodStart)} – ${monthName(last.periodStart)} ${ly}`
    : `${monthName(first.periodStart)} ${fy} – ${monthName(last.periodStart)} ${ly}`;
}

/** The prototype's compact money: "£1.7M" style is shortened as the reference shows it — "£1.69m", "£234.7k". */
export function compactMoney(value: string | null, currency: string): string {
  if (value === null) return '—';
  const d = parseDecimal(value);
  const symbol = formatMoney(0, { currency }).replace(/[\d.,\s]/g, '');
  const sign = d.isNegative() ? '−' : '';
  const a = d.abs();
  const trim = (s: string) => s.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  // 999,950 rounds to "1000k" on the thousands scale: it is shown as "1m" instead.
  if (a.greaterThanOrEqualTo(1_000_000) || a.dividedBy(1_000).toDecimalPlaces(1, ROUND_HALF_UP).greaterThanOrEqualTo(1_000)) return `${sign}${symbol}${trim(a.dividedBy(1_000_000).toDecimalPlaces(2, ROUND_HALF_UP).toFixed(2))}m`;
  if (a.greaterThanOrEqualTo(1_000)) return `${sign}${symbol}${trim(a.dividedBy(1_000).toDecimalPlaces(1, ROUND_HALF_UP).toFixed(1))}k`;
  return `${sign}${symbol}${a.toDecimalPlaces(0, ROUND_HALF_UP).toFixed(0)}`;
}

export interface Window {
  readonly label: string;
  readonly months: readonly MonthFacts[];
  readonly year: FinancialYear;
}

export interface AnnualComparison {
  readonly current: Window;
  /** The same months a year earlier, when every one of them has figures. */
  readonly previous: Window | null;
  /** True when `current` is a whole financial year (twelve months). */
  readonly wholeYear: boolean;
  /** Up to three financial years, oldest first (Comparative Financials). */
  readonly years: readonly FinancialYear[];
  readonly currency: string;
}

/**
 * One financial year's figures from a subset of its months. The marketing source is the one the
 * three-year table uses (`source`), never re-decided from the subset: otherwise a year whose months
 * happen to carry no Marketing account row would fall back to campaign spend and the "same months
 * last year" comparison would set accounts against campaigns.
 */
function yearOf(facts: AnnualFacts, months: readonly MonthFacts[], source: MarketingSource): FinancialYear | null {
  const built = buildMarketingFinancials({
    currency: facts.currency, fiscalYearStartMonth: facts.fiscalYearStartMonth, months,
    categorySpend: facts.categorySpend, accountSpend: [], campaignSpend: facts.campaignSpend, productSales: [],
    marketingSource: source,
  });
  return built?.years[built.years.length - 1] ?? null;
}

/** The latest financial year's months with figures, and the same months a year earlier. */
export function annualComparison(facts: AnnualFacts): AnnualComparison | null {
  const included = facts.months.filter(monthHasFigures).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const last = included[included.length - 1];
  if (last === undefined) return null;
  const fy = financialYearOf(last.periodStart, facts.fiscalYearStartMonth);
  const currentMonths = included.filter((m) => financialYearOf(m.periodStart, facts.fiscalYearStartMonth) === fy);
  const wholeYear = currentMonths.length >= 12;
  const allFacts = {
    currency: facts.currency, fiscalYearStartMonth: facts.fiscalYearStartMonth, months: facts.months,
    categorySpend: facts.categorySpend, accountSpend: [], campaignSpend: facts.campaignSpend, productSales: [],
  };
  const source = marketingSourceOf(allFacts);
  const currentYear = yearOf(facts, currentMonths, source);
  if (currentYear === null) return null;
  const byYm = new Map(included.map((m) => [ymKey(m.periodStart), m]));
  const earlier = currentMonths.map((m) => byYm.get(yearEarlier(m.periodStart)));
  const previousMonths = earlier.every((m): m is MonthFacts => m !== undefined) ? earlier : null;
  const previousYear = previousMonths ? yearOf(facts, previousMonths, source) : null;
  const all = buildMarketingFinancials(allFacts);
  return {
    current: { label: spanLabel(currentMonths, wholeYear ? fy : null), months: currentMonths, year: currentYear },
    previous: previousMonths && previousYear
      ? { label: spanLabel(previousMonths, wholeYear ? fy - 1 : null), months: previousMonths, year: previousYear }
      : null,
    wholeYear,
    years: all?.years ?? [],
    currency: facts.currency,
  };
}

const dec = (v: string | null) => (v === null ? null : parseDecimal(v));

/** "down 11%" / "up 4%" / "level" from the engine's change rule; null when it cannot be stated. */
function direction(previous: string | null, current: string | null): { word: 'up' | 'down' | 'level'; pct: string } | null {
  const change = changePercent(dec(previous), dec(current));
  if (change === null) return null;
  const d = parseDecimal(change);
  const pct = d.abs().toDecimalPlaces(0, ROUND_HALF_UP).toFixed(0);
  if (pct === '0') return { word: 'level', pct };
  return { word: d.isNegative() ? 'down' : 'up', pct };
}

export interface KeyIndicatorCard {
  readonly number: string;
  readonly change: string | null;
  readonly title: string;
  readonly value: string;
  readonly valueNote: string;
  readonly sentence: string;
  readonly focus: string;
}

export interface KeyIndicatorsView {
  readonly period: string;
  readonly cards: readonly KeyIndicatorCard[];
  readonly source: string;
}

/** The prototype's three "Key Report Indicators" cards, from the company's own year figures. */
export function keyIndicators(c: AnnualComparison): KeyIndicatorsView {
  const cur = c.current.year, prev = c.previous?.year ?? null;
  const money = (v: string | null) => compactMoney(v, c.currency);
  const period = c.previous ? `${c.current.label} vs ${c.previous.label}` : c.current.label;
  const noPrev = 'No earlier period with figures to compare yet.';

  const sales = direction(prev?.turnover ?? null, cur.turnover);
  const salesCard: KeyIndicatorCard = {
    number: '01',
    change: sales ? (sales.word === 'level' ? 'Sales level' : `Sales ${sales.word} ${sales.pct}%`) : null,
    title: 'Revenue Comparative',
    value: money(cur.turnover),
    valueNote: c.wholeYear ? 'annual turnover' : `turnover, ${c.current.label}`,
    sentence: !prev ? noPrev : sales === null ? `Sales were ${money(cur.turnover)}.`
      : sales.word === 'level' ? `Sales held level with ${c.previous!.label} at ${money(cur.turnover)}.`
      : `Sales ${sales.word === 'down' ? 'declined' : 'grew'} ${sales.pct}% ${c.wholeYear ? 'year on year' : `on the same months of ${c.previous!.label}`}, from ${money(prev.turnover)} to ${money(cur.turnover)}.`,
    focus: sales?.word === 'down' ? 'Find which customers or months drove the fall, and protect the ones that held up.'
      : sales?.word === 'up' ? 'Check the growth comes from customers you can keep, and that costs did not rise with it.'
      : 'Keep adding each month’s figures so the comparison stays current.',
  };

  const gp = direction(prev?.grossProfit ?? null, cur.grossProfit);
  const margin = cur.grossProfitPct;
  const prevMargin = prev?.grossProfitPct ?? null;
  const points = margin !== null && prevMargin !== null
    ? parseDecimal(margin).minus(parseDecimal(prevMargin)).toDecimalPlaces(1, ROUND_HALF_UP) : null;
  const narrowing = points !== null && points.isNegative();
  const widening = points !== null && points.greaterThan(0);
  const marginCard: KeyIndicatorCard = margin === null ? {
    number: '02', change: null, title: 'Gross margin', value: '—', valueNote: 'not available',
    sentence: 'Your figures have no cost of sales yet, so gross margin cannot be worked out.',
    focus: 'Add a ledger export or trial balance that shows cost of sales.',
  } : {
    number: '02',
    change: gp ? (gp.word === 'level' ? 'Gross profit level' : `Gross profit ${gp.word} ${gp.pct}%`) : null,
    title: narrowing ? 'Gross margin pressure' : widening ? 'Gross margin improving' : 'Gross margin',
    value: `${margin}%`,
    valueNote: prevMargin !== null ? `gross margin · ${prevMargin}% in ${c.previous!.label}` : 'gross margin',
    sentence: points === null ? `Gross profit was ${money(cur.grossProfit)}.`
      : `Gross profit ${gp?.word === 'down' ? 'fell to' : gp?.word === 'up' ? 'rose to' : 'was'} ${money(cur.grossProfit)}, with gross margin ${narrowing ? 'narrowing' : widening ? 'widening' : 'unchanged'}${points.isZero() ? '' : ` by ${points.abs().toFixed(1)} percentage points`}.`,
    focus: narrowing ? 'Review product margins, pricing and supplier costs.'
      : widening ? 'Find what improved the margin and make it the standard.'
      : 'Watch the margin each month for an early change.',
  };

  const np = direction(prev?.netProfit ?? null, cur.netProfit);
  const admin = direction(prev?.adminCosts ?? null, cur.adminCosts);
  const profitCard: KeyIndicatorCard = {
    number: '03',
    change: np ? (np.word === 'level' ? 'Net profit level' : `Net profit ${np.word} ${np.pct}%`) : null,
    title: 'Profit & cost discipline',
    value: money(cur.netProfit),
    valueNote: 'net profit',
    sentence: !prev ? noPrev : [
      np ? (np.word === 'level' ? 'Net profit held level.' : `Net profit ${np.word === 'down' ? 'fell' : 'rose'} ${np.pct}%.`) : `Net profit was ${money(cur.netProfit)}.`,
      admin && admin.word !== 'level'
        ? `Administrative costs ${admin.word === 'down' ? 'reduced' : 'rose'} ${admin.pct}% to ${money(cur.adminCosts)}${np?.word === 'down' && admin.word === 'down' ? ', cushioning the decline' : ''}.`
        : '',
    ].filter(Boolean).join(' '),
    focus: np?.word === 'down' && admin?.word === 'down' ? 'Protect sustainable savings and track returns on marketing spend.'
      : np?.word === 'down' ? 'Review which costs grew faster than sales.'
      : 'Keep the cost base steady as sales grow.',
  };

  return {
    period,
    cards: [salesCard, marginCard, profitCard],
    source: `Source: APX’s calculated monthly figures, totalled ${c.wholeYear ? 'by financial year' : 'for the months shown'} · ${period}. These highlights do not change with the dashboard’s period filters.`,
  };
}

// ---------------------------------------------------------------------------------------------
// How can I Grow?
// ---------------------------------------------------------------------------------------------

export type CostMode = 'fixed' | 'scale';
export const GROWTH_RATES = [10, 20, 30] as const;

export interface GrowthRow {
  readonly rate: number;
  readonly revenue: string;
  readonly cost: string;
  readonly profit: string;
  /** "+£34.2k" — the revenue added, as the card's summary line shows it. */
  readonly uplift: string;
  /** "£61.3k" — the projected profit, compact, for the same line. */
  readonly profitCompact: string;
}
export interface GrowthBaseline {
  readonly key: string;
  readonly label: string;
  readonly profitLabel: string;
  readonly revenue: string;
  readonly grossProfit: string;
  readonly profit: string;
  /** Rows for each cost mode, before additional investment (the component subtracts nothing: see `investmentSteps`). */
  readonly rows: Readonly<Record<CostMode, readonly GrowthRow[]>>;
}

/** The prototype's projection, in Decimal: profit = base + gross profit × g (fixed) or base × (1 + g) (scale). */
function project(revenue: Decimal, grossProfit: Decimal, profit: Decimal, rate: number, mode: CostMode, currency: string): GrowthRow {
  const g = new Decimal(rate).dividedBy(100);
  const projectedRevenue = revenue.times(g.plus(1));
  const projectedProfit = mode === 'scale' ? profit.times(g.plus(1)) : profit.plus(grossProfit.times(g));
  const m = (d: Decimal) => formatMoney(d.toDecimalPlaces(2, ROUND_HALF_UP).toFixed(2), { currency });
  return {
    rate,
    revenue: m(projectedRevenue),
    cost: m(projectedRevenue.minus(projectedProfit)),
    profit: m(projectedProfit),
    // The same words as `projectGrowthAction` (the rows with an investment), so the card's line reads
    // alike whether or not an investment is entered: "+£34.2k revenue · £61.3k net profit".
    uplift: `+${compactMoney(revenue.times(g).toFixed(2), currency)}`,
    profitCompact: compactMoney(projectedProfit.toFixed(2), currency),
  };
}

function baselineFrom(key: string, label: string, year: FinancialYear, months: number, currency: string): GrowthBaseline | null {
  if (year.turnover === null || year.grossProfit === null || year.netProfit === null) return null;
  const scale = new Decimal(12).dividedBy(months);
  const revenue = parseDecimal(year.turnover).times(scale);
  if (!revenue.greaterThan(0)) return null;
  const grossProfit = parseDecimal(year.grossProfit).times(scale);
  const profit = parseDecimal(year.netProfit).times(scale);
  const rows = (mode: CostMode) => GROWTH_RATES.map((r) => project(revenue, grossProfit, profit, r, mode, currency));
  return {
    key, label, profitLabel: 'Net profit',
    revenue: revenue.toFixed(2), grossProfit: grossProfit.toFixed(2), profit: profit.toFixed(2),
    rows: { fixed: rows('fixed'), scale: rows('scale') },
  };
}

/**
 * The baselines the growth card offers: the latest whole financial year as reported, and the current
 * period annualised (× 12 ÷ its months), as the prototype's "actual report · annual" and
 * "Dashboard sample · annualised".
 */
export function growthBaselines(c: AnnualComparison): GrowthBaseline[] {
  const out: GrowthBaseline[] = [];
  const whole = [...c.years].reverse().find((y) => !y.partial);
  if (whole) {
    const b = baselineFrom('report', `${whole.label} actual figures · annual`, whole, 12, c.currency);
    if (b) out.push(b);
  }
  if (!c.wholeYear || !whole) {
    const n = c.current.months.length;
    const b = baselineFrom('current', `${c.current.label} · annualised`, c.current.year, n, c.currency);
    if (b) out.push(b);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Comparative Financials and Marketing vs Revenue
// ---------------------------------------------------------------------------------------------

export interface ComparativeYear {
  readonly year: string;
  readonly sales: string | null;
  readonly cost: string | null;
  readonly profit: string | null;
  readonly salesDisplay: string;
  readonly costDisplay: string;
  readonly profitDisplay: string;
}

/** Sales and total costs per financial year; total costs = sales less net profit, as the prototype states. */
export function comparativeYears(c: AnnualComparison): ComparativeYear[] {
  return c.years.map((y) => {
    const cost = y.turnover !== null && y.netProfit !== null ? parseDecimal(y.turnover).minus(parseDecimal(y.netProfit)).toFixed(2) : null;
    const m = (v: string | null) => (v === null ? '—' : formatMoney(v, { currency: c.currency }));
    return { year: y.label, sales: y.turnover, cost, profit: y.netProfit, salesDisplay: m(y.turnover), costDisplay: m(cost), profitDisplay: m(y.netProfit) };
  });
}

export interface MarketingShare {
  readonly period: string;
  readonly revenue: string | null;
  readonly spend: string | null;
  /** 0–1, for the drawing only. */
  readonly share: number | null;
  readonly revenueDisplay: string;
  readonly spendDisplay: string;
  readonly shareDisplay: string;
}

export function marketingShare(c: AnnualComparison): MarketingShare {
  const y = c.current.year;
  const share = y.turnover !== null && y.marketingSpend !== null && parseDecimal(y.turnover).greaterThan(0)
    ? parseDecimal(y.marketingSpend).dividedBy(parseDecimal(y.turnover)) : null;
  return {
    period: c.current.label,
    revenue: y.turnover,
    spend: y.marketingSpend,
    share: share === null ? null : Math.min(1, Math.max(0, share.toNumber())),
    revenueDisplay: compactMoney(y.turnover, c.currency),
    spendDisplay: compactMoney(y.marketingSpend, c.currency),
    shareDisplay: y.marketingPct === null ? '—' : `${y.marketingPct}% of revenue`,
  };
}

// ---------------------------------------------------------------------------------------------
// Marketing vs Revenue over the dashboard's months
// ---------------------------------------------------------------------------------------------

export interface MarketingMonth {
  readonly periodId: string;
  readonly label: string;
  readonly revenue: string | null;
  readonly spend: string | null;
}

export interface MarketingWindow extends MarketingShare {
  readonly source: MarketingSource;
  readonly months: readonly MarketingMonth[];
}

/**
 * The prototype's "Marketing vs Revenue" (`marketingComparison`): the dashboard's selected months,
 * revenue against marketing spend, month by month. Spend follows Section 03's rule — the Marketing
 * account category first, campaign spend recorded in APX only when no Marketing account row exists
 * in these months, never the two added — decided once over the months shown so the rows are one
 * series. A month still in progress is included (the dashboard shows it); a figure the engine did
 * not state is null, never zero, and the totals cover only the months where both figures are stated.
 */
export function marketingWindow(
  facts: AnnualFacts, months: readonly { readonly periodId: string; readonly label: string }[], period: string,
): MarketingWindow {
  const byId = new Map(facts.months.map((m) => [m.periodId, m]));
  const ids = new Set(months.map((m) => m.periodId));
  const source: MarketingSource = facts.categorySpend.some((r) => r.category === 'marketing' && ids.has(r.periodId))
    ? 'accounts'
    : facts.campaignSpend.some((r) => ids.has(r.periodId)) ? 'campaigns' : null;

  const rows: MarketingMonth[] = months.map((m) => {
    const month = byId.get(m.periodId);
    const revenue = month?.figures.revenue?.value ?? null;
    let spend: Decimal | null = null;
    if (month !== undefined && source === 'accounts') spend = marketingFromAccounts([month], facts.categorySpend);
    // Campaign spend: a month with no recorded spend, in months that have some, spent nothing on campaigns.
    if (source === 'campaigns') {
      spend = facts.campaignSpend.filter((r) => r.periodId === m.periodId)
        .reduce((acc, r) => acc.plus(parseDecimal(r.amount)), new Decimal(0));
    }
    return { periodId: m.periodId, label: m.label, revenue, spend: spend === null ? null : spend.toFixed(2) };
  });

  // The totals cover the months where BOTH figures are stated (a month still without figures — the
  // current month, early on — is left out of both, so the share compares like with like).
  const paired = rows.filter((r) => r.revenue !== null && r.spend !== null);
  const sumOf = (pick: (r: MarketingMonth) => string) => paired.reduce((acc, r) => acc.plus(parseDecimal(pick(r))), new Decimal(0));
  const revenueOnly = rows.filter((r) => r.revenue !== null);
  const revenue = source === null
    ? (revenueOnly.length === 0 ? null : revenueOnly.reduce((acc, r) => acc.plus(parseDecimal(r.revenue!)), new Decimal(0)))
    : (paired.length === 0 ? null : sumOf((r) => r.revenue!));
  const spend = source === null || paired.length === 0 ? null : sumOf((r) => r.spend!);
  const share = revenue !== null && spend !== null && revenue.greaterThan(0) ? spend.dividedBy(revenue) : null;
  return {
    period,
    revenue: revenue === null ? null : revenue.toFixed(2),
    spend: spend === null ? null : spend.toFixed(2),
    share: share === null ? null : Math.min(1, Math.max(0, share.toNumber())),
    revenueDisplay: compactMoney(revenue === null ? null : revenue.toFixed(2), facts.currency),
    spendDisplay: compactMoney(spend === null ? null : spend.toFixed(2), facts.currency),
    shareDisplay: share === null ? '—' : `${share.times(100).toDecimalPlaces(1, ROUND_HALF_UP).toFixed(1)}% of revenue`,
    source,
    months: rows,
  };
}
