/**
 * Section 03 of the Marketing report — Financial overview & performance review (ADR-170) — built
 * from the product's own figures and never from the model's.
 *
 * The client's example states three financial years side by side (turnover, cost of sales, gross
 * profit, administrative costs, net profit and their shares of turnover), product-sector sales for
 * the last two years, advertising and marketing spend, and the largest cost lines of the latest year.
 * Every one of those is a figure the engine has already written MONTHLY to `metric_current`; this
 * file adds the months up into financial years under the registry's own roll-up rule
 * (`aggregation: 'sum'` for every money key read here, `'recompute'` for every ratio — CD-09:
 * "quarters and years are aggregates of months") and states the shares of turnover from those
 * totals. No metric is defined here: a figure the engine did not write is not invented.
 *
 * The AI writes the commentary beside these tables and may only restate what is in them, so the
 * rules that keep them honest are the engine's own, applied to a year:
 *
 *   - NEVER ZERO-FILL (FINANCIAL_ENGINE.md §1.5). A year's total is known only when every month in
 *     it is; one month the engine could not state makes the year unknown (null), never "the other
 *     eleven".
 *   - COMPLETE MONTHS ONLY, like the analyst's "FY2026" (AI_ARCHITECTURE.md §8): a month still in
 *     progress folded into a year reads as a finished figure and is not one. A year with fewer than
 *     twelve such months is `partial` and its label says how many it has.
 *   - ADR-106: a gross profit the engine wrote as revenue because there is no cost of sales to
 *     subtract is not a gross profit, and is null here exactly as Home, the Money page and the
 *     analyst omit it.
 *   - A percentage change across zero or across a change of sign is refused (§3.2), and so is one
 *     between two columns that do not cover the same months.
 *
 * Financial years are named by the calendar year they END in — "2026" is the year ended 30
 * September 2026 for an October year-start — which is how UK accounts and the client's example name
 * them, and what the analyst's "FY2026" already resolves to. (`core/periods`' `fiscalYear` names a
 * year by its START for the stored `fiscal_periods.fiscal_year`; the two agree for a January start.)
 * The source note spells the year-end out, so the label is never the only evidence of which months a
 * column holds.
 *
 * Money leaves as a decimal string with two places (ADR-006); a percentage as a decimal string with
 * one place and no sign ("57.4"), ROUND_HALF_UP applied once (UX_ARCHITECTURE.md §8.2).
 *
 * Pure: no I/O, no clock. `services/financials.ts` loads the facts.
 */

import {
  Decimal,
  PERCENT_DISPLAY_DECIMAL_PLACES,
  ROUND_HALF_UP,
  ZERO,
  compare,
  parseDecimal,
  toMoneyString,
} from '@/core/money';
import {
  fiscalMonthIndex,
  fiscalYearEnd,
  monthEnd,
  parseIsoDate,
  periodLabelLong,
  yearMonthOf,
} from '@/core/periods';
import { metricAvailability } from '@/modules/financials';
import type { CostLine, FinancialYear, MarketingFinancials, ProductSales } from './types';

// ---------------------------------------------------------------------------------------------
// The facts the service loads
// ---------------------------------------------------------------------------------------------

/**
 * The undimensioned engine figures Section 03 reads, by the registry's own keys (FINANCIAL_ENGINE.md
 * §3.1). Turnover is `revenue`; administrative costs are `operating_expenses` (overheads, payroll,
 * marketing, depreciation); net profit is `net_profit`, which the engine states after interest and
 * any tax charged. `other_income` and `tax_expense` are read only for the source note.
 */
export const SECTION_03_KEYS = [
  'revenue', 'cost_of_sales', 'gross_profit', 'operating_expenses', 'net_profit', 'other_income', 'tax_expense',
] as const;
export type Section03Key = (typeof SECTION_03_KEYS)[number];

/** The keys whose presence says a month has profit-and-loss figures at all. */
const HEADLINE_KEYS: readonly Section03Key[] = ['revenue', 'cost_of_sales', 'operating_expenses', 'net_profit'];

/** One engine figure as `metric_current` points at it: the value, and what ADR-106 reads. */
export interface FigureFact {
  readonly value: string | null;
  /** `metric_snapshots.basis` — 'ledger', 'period_balances', 'bank', 'invoices', 'mixed', 'none'. */
  readonly basis: string;
  readonly warnings: readonly string[];
  readonly missing: readonly string[];
}

/** One fiscal month and the Section 03 figures the engine wrote for it. */
export interface MonthFacts {
  readonly periodId: string;
  /** `fiscal_periods.period_start`, the first of the month. */
  readonly periodStart: string;
  /** `fiscal_periods.period_end`, the last day of the month. */
  readonly periodEnd: string;
  readonly isComplete: boolean;
  /** A key with no current snapshot is absent; that is never read as zero. */
  readonly figures: Readonly<Partial<Record<Section03Key, FigureFact>>>;
}

/** `expense_by_category` for one month and one standard category (dimension_key, ADR-053). */
export interface CategorySpendFact {
  readonly periodId: string;
  readonly category: string;
  /** The Money page's own words for the category (`categoryLabel`). */
  readonly label: string;
  readonly value: string | null;
}

/** `expense_by_account` for one month and one expense account — written only on an account basis. */
export interface AccountSpendFact {
  readonly periodId: string;
  readonly accountId: string;
  readonly name: string;
  /** The account's standard category as the run recorded it (`components.category`). */
  readonly category: string;
  readonly value: string | null;
}

/** One recorded campaign-spend row (`campaign_spend`, ADR-102). */
export interface CampaignSpendFact {
  readonly periodId: string;
  readonly amount: string;
}

/**
 * One invoice line attributed to a product, SIGNED: a sales line positive, a sales credit note's
 * line negative — `api.product_period_summary`'s `sales` rule, line by line.
 */
export interface ProductSalesFact {
  readonly periodId: string;
  readonly productId: string;
  readonly product: string;
  readonly amount: string;
}

export interface FinancialFacts {
  /** `organizations.base_currency`. */
  readonly currency: string;
  /** `organizations.fiscal_year_start_month`, 1–12. */
  readonly fiscalYearStartMonth: number;
  /** Every month the service read, in any order. */
  readonly months: readonly MonthFacts[];
  readonly categorySpend: readonly CategorySpendFact[];
  readonly accountSpend: readonly AccountSpendFact[];
  readonly campaignSpend: readonly CampaignSpendFact[];
  readonly productSales: readonly ProductSalesFact[];
}

// ---------------------------------------------------------------------------------------------
// Financial years
// ---------------------------------------------------------------------------------------------

/** The client's example: the latest three financial years. */
export const REPORT_YEAR_COUNT = 3;
/** 3.4: the largest four cost lines of the latest year. */
export const COST_LINE_COUNT = 4;
/** 3.2: at most this many product rows; the rest are added into one "All other products" row. */
export const PRODUCT_ROW_LIMIT = 8;

/**
 * True when a month can stand in a year's total: it is complete, and the engine stated at least one
 * of its headline profit-and-loss figures. A month no source covers is written as NULL
 * `no_source_covers_period` across the family (§2.3) and is simply not part of any year.
 */
export function monthHasFigures(month: MonthFacts): boolean {
  if (!month.isComplete) return false;
  return HEADLINE_KEYS.some((key) => {
    const figure = month.figures[key];
    return figure !== undefined && figure.value !== null;
  });
}

/** The calendar year the financial year containing this month ENDS in — the year's name here. */
export function financialYearOf(periodStart: string, fiscalYearStartMonth: number): number {
  return fiscalYearEnd(yearMonthOf(periodStart), fiscalYearStartMonth).year;
}

export interface ReportYear {
  /** The calendar year the financial year ends in. */
  readonly year: number;
  /** The months whose figures make up the year: complete, with figures, oldest first. */
  readonly months: readonly MonthFacts[];
}

/**
 * The financial years Section 03 shows, oldest first: the year of the latest month with figures and
 * the two before it, each holding only the months that can stand in a total. A year in that window
 * with no such month is left out rather than shown as a column of blanks.
 */
export function reportYears(months: readonly MonthFacts[], fiscalYearStartMonth: number): ReportYear[] {
  const included = months.filter(monthHasFigures).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const last = included[included.length - 1];
  if (last === undefined) return [];
  const latest = financialYearOf(last.periodStart, fiscalYearStartMonth);
  const years: ReportYear[] = [];
  for (let year = latest - REPORT_YEAR_COUNT + 1; year <= latest; year += 1) {
    const inYear = included.filter((m) => financialYearOf(m.periodStart, fiscalYearStartMonth) === year);
    if (inYear.length > 0) years.push({ year, months: inYear });
  }
  return years;
}

/** "2026", or "2026 (9 months)" when the year has fewer than twelve months of figures. */
export function yearLabel(year: ReportYear): string {
  const count = year.months.length;
  return count >= 12 ? String(year.year) : `${year.year} (${count} ${count === 1 ? 'month' : 'months'})`;
}

// ---------------------------------------------------------------------------------------------
// Sums and shares
// ---------------------------------------------------------------------------------------------

/**
 * A year's total of one key: the sum of its months, or null when any month's figure is absent or
 * NULL (§1.5). A year is not "the months we happen to know".
 */
function yearTotal(months: readonly MonthFacts[], key: Section03Key): Decimal | null {
  let total = ZERO;
  for (const month of months) {
    const figure = month.figures[key];
    if (figure === undefined || figure.value === null) return null;
    total = total.plus(parseDecimal(figure.value));
  }
  return total;
}

/**
 * Gross profit under ADR-106's one availability rule: a month whose gross profit is revenue because
 * there is no cost of sales to subtract makes the year's gross profit unknown, not equal to turnover.
 */
function grossProfitTotal(months: readonly MonthFacts[]): Decimal | null {
  for (const month of months) {
    const grossProfit = month.figures.gross_profit;
    if (grossProfit === undefined) return null;
    const availability = metricAvailability('gross_profit', grossProfit, month.figures.cost_of_sales ?? null);
    if (availability.state === 'not_applicable') return null;
  }
  return yearTotal(months, 'gross_profit');
}

/** A ratio as a one-place percentage string, ROUND_HALF_UP once; never "-0.0". */
function percentString(ratio: Decimal): string {
  const percent = ratio.times(100).toDecimalPlaces(PERCENT_DISPLAY_DECIMAL_PLACES, ROUND_HALF_UP);
  return percent.isZero() ? (0).toFixed(PERCENT_DISPLAY_DECIMAL_PLACES) : percent.toFixed(PERCENT_DISPLAY_DECIMAL_PLACES);
}

/**
 * `part` as a percentage of turnover — null when either is unknown, or when turnover is not positive:
 * a share of nothing, or of a net refund, is not a margin anybody can read.
 */
export function shareOfTurnover(part: Decimal | null, turnover: Decimal | null): string | null {
  if (part === null || turnover === null || !turnover.greaterThan(0)) return null;
  return percentString(part.dividedBy(turnover));
}

/**
 * The engine's percentage change (§3.2): (current − previous) / |previous|, NULL when either side is
 * unknown, when the comparison is zero, and across a change of sign.
 */
export function changePercent(previous: Decimal | null, current: Decimal | null): string | null {
  if (previous === null || current === null || previous.isZero()) return null;
  const sign = (d: Decimal) => (d.greaterThan(0) ? 1 : d.lessThan(0) ? -1 : 0);
  if (sign(previous) * sign(current) < 0) return null;
  return percentString(current.minus(previous).dividedBy(previous.abs()));
}

const money = (value: Decimal | null): string | null => (value === null ? null : toMoneyString(value));

// ---------------------------------------------------------------------------------------------
// 3.3 Advertising and marketing
// ---------------------------------------------------------------------------------------------

/** Where the marketing row comes from — one source for every year, so the row is one series. */
export type MarketingSource = 'accounts' | 'campaigns' | null;

/**
 * The accounts first: `expense_by_category[marketing]` is the figure the engine's contribution margin
 * and the Money page's "Marketing" line already read, so the report agrees with both. Campaign spend
 * recorded in Commercial (the figure Marketing Efficiency reads, ADR-147) stands in only when no
 * account classified as Marketing carries anything in the window: the two are never added together,
 * because a campaign's spend is normally ALSO posted to an account, and adding them would count it
 * twice.
 */
function marketingSource(years: readonly ReportYear[], facts: FinancialFacts): MarketingSource {
  const ids = new Set(years.flatMap((y) => y.months.map((m) => m.periodId)));
  if (facts.categorySpend.some((r) => r.category === 'marketing' && ids.has(r.periodId))) return 'accounts';
  if (facts.campaignSpend.some((r) => ids.has(r.periodId))) return 'campaigns';
  return null;
}

function marketingFromAccounts(months: readonly MonthFacts[], categorySpend: readonly CategorySpendFact[]): Decimal | null {
  let total = ZERO;
  for (const month of months) {
    const row = categorySpend.find((r) => r.periodId === month.periodId && r.category === 'marketing');
    if (row !== undefined) {
      if (row.value === null) return null;
      total = total.plus(parseDecimal(row.value));
      continue;
    }
    /*
     * No Marketing row. The engine writes a category only when it has rows (§3.1), so a month whose
     * running costs ARE stated had nothing posted to Marketing — the same known zero `coveredTotal`
     * gives a stated statement's absent line. A month whose costs nothing establishes (FU-12) is
     * unknown, and so is the year.
     */
    const runningCosts = month.figures.operating_expenses;
    if (runningCosts === undefined || runningCosts.value === null) return null;
  }
  return total;
}

/** Recorded campaign spend for the year's months; null for a year with none recorded at all. */
function marketingFromCampaigns(months: readonly MonthFacts[], campaignSpend: readonly CampaignSpendFact[]): Decimal | null {
  const ids = new Set(months.map((m) => m.periodId));
  const rows = campaignSpend.filter((r) => ids.has(r.periodId));
  if (rows.length === 0) return null;
  return rows.reduce((acc, r) => acc.plus(parseDecimal(r.amount)), ZERO);
}

// ---------------------------------------------------------------------------------------------
// 3.4 Cost lines
// ---------------------------------------------------------------------------------------------

/**
 * Not cost lines: `other_income` is income (it sits in `expense_by_category` only because §3.1 puts
 * it there), and tax is a charge on profit, not a cost a commercial action can address.
 */
const NOT_A_COST_LINE: ReadonlySet<string> = new Set(['other_income', 'tax_expense']);

export type CostLineLevel = 'account' | 'category';

/**
 * The latest year's largest cost lines, from the same breakdowns the Money page's spending list
 * reads: per ACCOUNT where the engine wrote `expense_by_account` for every month that had costs (a
 * ledger or a set of reports), otherwise per standard CATEGORY — the bank basis categorises a
 * transaction but posts it to no account, so there is nothing finer to name (§3.1).
 *
 * A line is summed like any year total: a month in which it is NULL leaves it unknown, and it is left
 * out rather than shown at a guessed size. When any month's running costs are themselves unknown, no
 * line can be stated — a list built from the months that happened to be covered would rank partial
 * totals as though they were the year's.
 */
function costLines(latest: ReportYear, facts: FinancialFacts): { lines: CostLine[]; level: CostLineLevel | null } {
  if (latest.months.some((m) => m.figures.operating_expenses?.value == null)) return { lines: [], level: null };
  const ids = new Set(latest.months.map((m) => m.periodId));
  const categoryRows = facts.categorySpend.filter((r) => ids.has(r.periodId) && !NOT_A_COST_LINE.has(r.category));
  const accountRows = facts.accountSpend.filter((r) => ids.has(r.periodId) && !NOT_A_COST_LINE.has(r.category));
  const monthsWithAccounts = new Set(facts.accountSpend.filter((r) => ids.has(r.periodId)).map((r) => r.periodId));
  const byAccount = accountRows.length > 0 && categoryRows.every((r) => monthsWithAccounts.has(r.periodId));

  const rows = byAccount
    ? accountRows.map((r) => ({ key: r.accountId, name: r.name, value: r.value }))
    : categoryRows.map((r) => ({ key: r.category, name: r.label, value: r.value }));
  if (rows.length === 0) return { lines: [], level: null };

  const totals = new Map<string, { name: string; total: Decimal | null }>();
  for (const row of rows) {
    const seen = totals.get(row.key) ?? { name: row.name, total: ZERO };
    const total = seen.total === null || row.value === null ? null : seen.total.plus(parseDecimal(row.value));
    totals.set(row.key, { name: seen.name, total });
  }
  const lines = [...totals.values()]
    .filter((t): t is { name: string; total: Decimal } => t.total !== null && t.total.greaterThan(0))
    .sort((a, b) => compare(b.total, a.total) || a.name.localeCompare(b.name))
    .slice(0, COST_LINE_COUNT)
    .map((t) => ({ name: t.name, amount: toMoneyString(t.total) }));
  return { lines, level: byAccount ? 'account' : 'category' };
}

// ---------------------------------------------------------------------------------------------
// 3.2 Product sales
// ---------------------------------------------------------------------------------------------

interface ProductSection {
  readonly section: NonNullable<MarketingFinancials['productSales']>;
  /** True when both columns cover the same months, so a change can be stated. */
  readonly comparable: boolean;
  readonly previousHasSales: boolean;
}

/** Signed attributed sales per product over a set of months, or null when no line names any product. */
function productTotals(rows: readonly ProductSalesFact[], ids: ReadonlySet<string>): Map<string, Decimal> | null {
  const within = rows.filter((r) => ids.has(r.periodId));
  if (within.length === 0) return null;
  const totals = new Map<string, Decimal>();
  for (const row of within) totals.set(row.productId, (totals.get(row.productId) ?? ZERO).plus(parseDecimal(row.amount)));
  return totals;
}

const byValueDesc = (a: Decimal | null, b: Decimal | null): number => {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return compare(b, a);
};

/**
 * Sales by product for the latest year against the year before (the products the business has
 * recorded in Commercial, attributed by invoice lines — ADR-102).
 *
 * LIKE FOR LIKE. When the latest year is partial, the previous column holds the SAME fiscal months of
 * the previous year ("2025 (same 9 months)"), so a change compares nine months with nine months
 * rather than with twelve. When the previous year lacks some of those months, both columns are still
 * shown but no change is: the columns cover different months.
 *
 * A year in which no line names any product says nothing about products — its column is null. In a
 * year in which lines DO name products, a product none of them names sold nothing attributable: zero,
 * exactly as the Products page reports it.
 */
function productSales(years: readonly ReportYear[], facts: FinancialFacts): ProductSection | null {
  const current = years[years.length - 1];
  if (current === undefined) return null;
  const start = facts.fiscalYearStartMonth;
  const indexOf = (m: MonthFacts) => fiscalMonthIndex(yearMonthOf(m.periodStart), start);
  const currentIndexes = new Set(current.months.map(indexOf));
  const previousYear = years.find((y) => y.year === current.year - 1);
  const previousMonths = (previousYear?.months ?? []).filter((m) => currentIndexes.has(indexOf(m)));
  const comparable = previousMonths.length === current.months.length;

  const currentTotals = productTotals(facts.productSales, new Set(current.months.map((m) => m.periodId)));
  const previousTotals = productTotals(facts.productSales, new Set(previousMonths.map((m) => m.periodId)));
  if (currentTotals === null && previousTotals === null) return null;

  const names = new Map<string, string>();
  for (const row of facts.productSales) if (!names.has(row.productId)) names.set(row.productId, row.product);
  const ids = new Set([...(currentTotals?.keys() ?? []), ...(previousTotals?.keys() ?? [])]);
  const valueIn = (totals: Map<string, Decimal> | null, id: string) => (totals === null ? null : totals.get(id) ?? ZERO);

  const ranked = [...ids]
    .map((id) => ({ product: names.get(id) ?? 'Unnamed product', previous: valueIn(previousTotals, id), current: valueIn(currentTotals, id) }))
    .sort((a, b) => byValueDesc(a.current, b.current) || byValueDesc(a.previous, b.previous) || a.product.localeCompare(b.product));

  let shown = ranked;
  if (ranked.length > PRODUCT_ROW_LIMIT) {
    const rest = ranked.slice(PRODUCT_ROW_LIMIT - 1);
    const add = (pick: (r: (typeof ranked)[number]) => Decimal | null) =>
      rest.reduce<Decimal | null>((acc, r) => (acc === null || pick(r) === null ? null : acc.plus(pick(r)!)), ZERO);
    shown = [
      ...ranked.slice(0, PRODUCT_ROW_LIMIT - 1),
      { product: 'All other products', previous: add((r) => r.previous), current: add((r) => r.current) },
    ];
  }

  const rows: ProductSales[] = shown.map((r) => ({
    product: r.product,
    previous: money(r.previous),
    current: money(r.current),
    changePct: comparable ? changePercent(r.previous, r.current) : null,
  }));

  const previousName = current.year - 1;
  const previousLabel = previousMonths.length === 0 || (comparable && current.months.length >= 12)
    ? String(previousName)
    : comparable
      ? `${previousName} (same ${current.months.length} months)`
      : `${previousName} (${previousMonths.length} ${previousMonths.length === 1 ? 'month' : 'months'})`;

  return {
    section: { previousLabel, currentLabel: yearLabel(current), rows },
    comparable,
    previousHasSales: previousTotals !== null,
  };
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

/** "a", "a and b", "a, b and c". */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The last day of the financial year a report year names. */
function yearEndDate(year: ReportYear, fiscalYearStartMonth: number): string {
  return monthEnd(fiscalYearEnd(yearMonthOf(year.months[0]!.periodStart), fiscalYearStartMonth));
}

/**
 * "Financial years ended 30 September 2024 and 2025, and the six months to 31 March 2026 (part of
 * the financial year to 30 September 2026)." Consecutive whole years are named together, as the
 * client's example does; a partial year says which months it holds.
 */
function periodSentence(years: readonly ReportYear[], fiscalYearStartMonth: number): string {
  const segments: string[] = [];
  let whole: ReportYear[] = [];
  const flush = () => {
    if (whole.length === 0) return;
    const ends = whole.map((y) => longDate(yearEndDate(y, fiscalYearStartMonth)));
    const dayMonths = new Set(ends.map((e) => e.replace(/ \d{4}$/, '')));
    const named = dayMonths.size === 1
      ? `${[...dayMonths][0]} ${joinList(whole.map((y) => String(y.year)))}`
      : joinList(ends);
    segments.push(`financial year${whole.length > 1 ? 's' : ''} ended ${named}`);
    whole = [];
  };
  for (const year of years) {
    if (year.months.length >= 12) {
      whole.push(year);
      continue;
    }
    flush();
    const count = year.months.length;
    const last = year.months[count - 1]!;
    segments.push(
      `the ${NUMBER_WORDS[count]} ${count === 1 ? 'month' : 'months'} to ${longDate(last.periodEnd)}`
      + ` (part of the financial year to ${longDate(yearEndDate(year, fiscalYearStartMonth))})`,
    );
  }
  flush();
  // A segment can itself contain "and" ("2024 and 2025"), so segments are joined with a comma first.
  const sentence = segments.length <= 1
    ? segments.join('')
    : `${segments.slice(0, -1).join(', ')}, and ${segments[segments.length - 1]}`;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** What each basis is, in the words a reader of the report uses (BASIS_TEXT, as a noun phrase). */
const BASIS_WORDS: Readonly<Record<string, string>> = {
  ledger: 'accounts',
  period_balances: 'accounting reports',
  bank: 'bank statements',
  invoices: 'invoices',
  mixed: 'records from more than one source',
};

function basisPhrase(years: readonly ReportYear[]): string {
  const seen: string[] = [];
  for (const month of years.flatMap((y) => y.months)) {
    for (const key of HEADLINE_KEYS) {
      const words = BASIS_WORDS[month.figures[key]?.basis ?? ''];
      if (words !== undefined && !seen.includes(words)) seen.push(words);
    }
  }
  return seen.length === 0 ? 'records' : joinList(seen);
}

interface NoteFacts {
  readonly years: readonly ReportYear[];
  readonly overview: readonly FinancialYear[];
  readonly currency: string;
  readonly fiscalYearStartMonth: number;
  readonly marketing: MarketingSource;
  readonly products: ProductSection | null;
  readonly costLevel: CostLineLevel | null;
}

/**
 * The note under the tables — the client's "Financial years ended … All figures GBP. Source: …" —
 * and, because the AI may only restate what the tables hold, every qualification a reader needs to
 * read them correctly: what net profit is after, where marketing spend comes from, what the product
 * figures leave out. Each sentence appears only when it is true of these figures.
 */
function sourceNote(facts: NoteFacts): string {
  const { years, overview } = facts;
  const sentences = [
    periodSentence(years, facts.fiscalYearStartMonth),
    `All figures ${facts.currency}.`,
    `Source: the company's own records in APX — the monthly profit and loss figures APX calculated from its ${basisPhrase(years)}, added together for each financial year.`,
  ];

  const taxes = years.map((y) => yearTotal(y.months, 'tax_expense'));
  sentences.push(taxes.every((t) => t === null || t.isZero())
    ? 'Net profit is after interest and any tax recorded in the accounts; no tax charge is recorded in these figures.'
    : 'Net profit is after interest and the tax recorded in the accounts.');

  if (years.some((y) => { const other = yearTotal(y.months, 'other_income'); return other !== null && !other.isZero(); })) {
    sentences.push('Turnover is trading revenue: other income is included in net profit but not in turnover.');
  }
  if (overview.some((y) => y.turnover !== null && y.costOfSales === null)) {
    sentences.push('Cost of sales and gross profit are left blank where the records do not state direct costs for every month of the year.');
  }

  sentences.push(facts.marketing === 'accounts'
    ? 'Advertising and marketing is the spend on accounts classified as Marketing in APX.'
    : facts.marketing === 'campaigns'
      ? 'Advertising and marketing is the campaign spend recorded in APX; no spend is recorded on accounts classified as Marketing.'
      : 'Advertising and marketing spend is not shown: no spend is recorded on accounts classified as Marketing, and no campaign spend is recorded in APX.');

  if (facts.products !== null) {
    sentences.push('Product sales are the invoice lines attributed to each product in APX, less credit notes; sales not attributed to a product are not included.');
    if (!facts.products.comparable && facts.products.previousHasSales) {
      sentences.push('No change is shown for product sales because the two columns do not cover the same months.');
    }
  }
  if (facts.costLevel === 'category') {
    sentences.push('The largest costs are shown by spending category, because these records do not post costs to individual accounts.');
  }
  return sentences.join(' ');
}

// ---------------------------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------------------------

/** One column of the three-year overview. */
function financialYear(year: ReportYear, facts: FinancialFacts, marketing: MarketingSource): FinancialYear {
  const months = year.months;
  const turnover = yearTotal(months, 'revenue');
  const costOfSales = yearTotal(months, 'cost_of_sales');
  const grossProfit = grossProfitTotal(months);
  const netProfit = yearTotal(months, 'net_profit');
  const marketingSpend = marketing === 'accounts'
    ? marketingFromAccounts(months, facts.categorySpend)
    : marketing === 'campaigns' ? marketingFromCampaigns(months, facts.campaignSpend) : null;
  return {
    label: yearLabel(year),
    periodStart: months[0]!.periodStart,
    periodEnd: months[months.length - 1]!.periodEnd,
    partial: months.length < 12,
    turnover: money(turnover),
    costOfSales: money(costOfSales),
    costOfSalesPct: shareOfTurnover(costOfSales, turnover),
    grossProfit: money(grossProfit),
    grossProfitPct: shareOfTurnover(grossProfit, turnover),
    adminCosts: money(yearTotal(months, 'operating_expenses')),
    netProfit: money(netProfit),
    netProfitPct: shareOfTurnover(netProfit, turnover),
    marketingSpend: money(marketingSpend),
    marketingPct: shareOfTurnover(marketingSpend, turnover),
  };
}

/**
 * Section 03's tables from the loaded facts, or null when the company has no month with figures —
 * the report then has no Section 03 tables and the commentary is null too (`MarketingNarrative`).
 *
 * `periodStart`/`periodEnd` of a year are the months its figures actually cover (the first month's
 * start and the last month's end), which for a whole year are the financial year's own bounds.
 */
export function buildMarketingFinancials(facts: FinancialFacts): MarketingFinancials | null {
  const years = reportYears(facts.months, facts.fiscalYearStartMonth);
  const latest = years[years.length - 1];
  if (latest === undefined) return null;

  const marketing = marketingSource(years, facts);
  const overview = years.map((y) => financialYear(y, facts, marketing));
  const products = productSales(years, facts);
  const costs = costLines(latest, facts);

  return {
    currency: facts.currency,
    years: overview,
    productSales: products?.section ?? null,
    costLines: costs.lines,
    sourceNote: sourceNote({
      years, overview, currency: facts.currency, fiscalYearStartMonth: facts.fiscalYearStartMonth,
      marketing, products, costLevel: costs.lines.length > 0 ? costs.level : null,
    }),
  };
}
