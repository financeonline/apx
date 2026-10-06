import { ZERO, abs, add, divide, isZero, parseMoney, subtract, toMoneyString, toRatioString, type Decimal } from '@/core/money';

/**
 * Budget against actual (Agreement §9 "budget/forecast variance"; REQ-FC-03/04; ADR-142).
 *
 * Pure and deterministic. The ACTUAL side is never computed here: every actual is a figure the
 * engine already wrote for the month (`metric_current`), read by key. The BUDGET side is the sum of
 * the month's current budget lines by standard category. This file only lines the two up, in the
 * engine's own P&L order, and subtracts.
 *
 *   - Lines follow the engine's structure (`financial-engine/domain/pnl.ts`): revenue, other income,
 *     cost of sales, gross profit, the four operating-expense categories (`OPEX_CATEGORIES`),
 *     operating expenses, operating profit, the three costs below the line, net profit.
 *   - A budgeted PROFIT is derived the way the engine derives the actual: gross = revenue − cost of
 *     sales; operating = gross − operating expenses; net = operating + other income − other,
 *     interest and tax expenses. A category with no budget line counts as zero in a derived profit,
 *     and the row says so — a budget usually lists every line it plans for.
 *   - An actual the engine could not establish is ABSENT, never zero: the variance is absent too,
 *     and the engine's reason is carried.
 *   - Favourable means actual above budget for income and profit, below budget for costs.
 *   - Budget lines in categories that are not in the profit and loss (cash, loans, equity…) are not
 *     compared; they are listed so nothing budgeted disappears.
 */

export const BUDGET_VARIANCE_VERSION = 'budget_variance.v1';

export type BudgetLineKey =
  | 'revenue' | 'other_income' | 'cost_of_sales' | 'gross_profit'
  | 'operating_expense' | 'payroll' | 'marketing' | 'depreciation' | 'operating_expenses'
  | 'operating_profit' | 'other_expense' | 'interest_expense' | 'tax_expense' | 'net_profit';

type Kind = 'income' | 'cost' | 'profit';

interface LineSpec {
  readonly key: BudgetLineKey;
  readonly kind: Kind;
  readonly derived: boolean;
  /** Where the actual is read: a scalar metric key, or `expense_by_category` with its category. */
  readonly actual: { readonly metric: string; readonly category?: string };
}

/** The engine's P&L, in its order. */
export const BUDGET_LINES: readonly LineSpec[] = [
  { key: 'revenue', kind: 'income', derived: false, actual: { metric: 'revenue' } },
  { key: 'other_income', kind: 'income', derived: false, actual: { metric: 'other_income' } },
  { key: 'cost_of_sales', kind: 'cost', derived: false, actual: { metric: 'cost_of_sales' } },
  { key: 'gross_profit', kind: 'profit', derived: true, actual: { metric: 'gross_profit' } },
  { key: 'operating_expense', kind: 'cost', derived: false, actual: { metric: 'expense_by_category', category: 'operating_expense' } },
  { key: 'payroll', kind: 'cost', derived: false, actual: { metric: 'expense_by_category', category: 'payroll' } },
  { key: 'marketing', kind: 'cost', derived: false, actual: { metric: 'expense_by_category', category: 'marketing' } },
  { key: 'depreciation', kind: 'cost', derived: false, actual: { metric: 'expense_by_category', category: 'depreciation' } },
  { key: 'operating_expenses', kind: 'cost', derived: true, actual: { metric: 'operating_expenses' } },
  { key: 'operating_profit', kind: 'profit', derived: true, actual: { metric: 'operating_profit' } },
  { key: 'other_expense', kind: 'cost', derived: false, actual: { metric: 'other_expense' } },
  { key: 'interest_expense', kind: 'cost', derived: false, actual: { metric: 'interest_expense' } },
  { key: 'tax_expense', kind: 'cost', derived: false, actual: { metric: 'tax_expense' } },
  { key: 'net_profit', kind: 'profit', derived: true, actual: { metric: 'net_profit' } },
];

const COMPARED_CATEGORIES = new Set([
  'revenue', 'other_income', 'cost_of_sales', 'operating_expense', 'payroll', 'marketing', 'depreciation',
  'other_expense', 'interest_expense', 'tax_expense',
]);

export interface ActualFigure {
  /** Exact decimal string, reporting sign (costs positive); NULL when the engine could not state it. */
  readonly value: string | null;
  readonly snapshotId: string | null;
  /** The engine's `data_quality.missing` codes when the value is NULL. */
  readonly missing: readonly string[];
  readonly statusLabel: string | null;
}

export interface BudgetInput {
  /** Σ current budget lines by standard category for the month. */
  readonly budgetByCategory: ReadonlyMap<string, string>;
  /** Actual figures by line key (see `BUDGET_LINES[].actual`), NULL when no snapshot exists. */
  readonly actualByLine: ReadonlyMap<BudgetLineKey, ActualFigure | null>;
}

export interface VarianceRow {
  readonly key: BudgetLineKey;
  readonly kind: Kind;
  readonly derived: boolean;
  readonly budget: string | null;
  readonly actual: string | null;
  readonly actualSnapshotId: string | null;
  readonly actualMissing: readonly string[];
  readonly actualStatusLabel: string | null;
  /** actual − budget; NULL when either side is absent. */
  readonly variance: string | null;
  /** variance ÷ budget, a ratio; NULL when the budget is zero or either side is absent. */
  readonly variancePct: string | null;
  readonly favourable: boolean | null;
  /** A derived budgeted profit that counted some unbudgeted category as zero. */
  readonly assumedZero: readonly string[];
}

export interface BudgetVariance {
  readonly version: typeof BUDGET_VARIANCE_VERSION;
  readonly rows: readonly VarianceRow[];
  /** Budgeted categories that are not in the profit and loss, with their totals. */
  readonly notCompared: readonly { readonly category: string; readonly budget: string }[];
}

export function computeBudgetVariance(input: BudgetInput): BudgetVariance {
  const budgeted = (category: string): Decimal | null => {
    const raw = input.budgetByCategory.get(category);
    return raw === undefined ? null : parseMoney(raw);
  };
  const orZero = (category: string, assumed: string[]): Decimal => {
    const value = budgeted(category);
    if (value === null) { assumed.push(category); return ZERO; }
    return value;
  };

  const derivedBudget = (key: BudgetLineKey): { value: Decimal | null; assumed: string[] } => {
    const assumed: string[] = [];
    const opexCategories = ['operating_expense', 'payroll', 'marketing', 'depreciation'];
    // The cost total is a total of costs: it stands whenever any of them is budgeted.
    if (key === 'operating_expenses') {
      if (!opexCategories.some((c) => budgeted(c) !== null)) return { value: null, assumed: [] };
      const total = opexCategories.reduce<Decimal>((sum, c) => add(sum, orZero(c, assumed)), ZERO);
      return { value: total, assumed };
    }
    // A derived profit needs at least one income line budgeted; without it, it is not a budget.
    if (budgeted('revenue') === null && budgeted('other_income') === null) return { value: null, assumed };
    const revenue = orZero('revenue', assumed);
    const cos = orZero('cost_of_sales', assumed);
    const gross = subtract(revenue, cos);
    if (key === 'gross_profit') return { value: gross, assumed };
    const opex = opexCategories.reduce<Decimal>((total, c) => add(total, orZero(c, assumed)), ZERO);
    const operating = subtract(gross, opex);
    if (key === 'operating_profit') return { value: operating, assumed };
    const below = ['other_expense', 'interest_expense', 'tax_expense']
      .reduce<Decimal>((total, c) => add(total, orZero(c, assumed)), ZERO);
    return { value: subtract(add(operating, orZero('other_income', assumed)), below), assumed };
  };

  const rows: VarianceRow[] = [];
  for (const line of BUDGET_LINES) {
    let budget: Decimal | null;
    let assumed: string[] = [];
    if (line.derived) {
      const derived = derivedBudget(line.key);
      budget = derived.value;
      assumed = derived.value === null ? [] : derived.assumed;
    } else {
      budget = budgeted(line.key);
    }
    const actual = input.actualByLine.get(line.key) ?? null;
    // A line with neither a budget nor an actual figure says nothing; it is left out.
    if (budget === null && (actual === null || actual.value === null) && !line.derived) continue;
    if (budget === null && line.derived) continue;

    const actualValue = actual?.value ?? null;
    const variance = budget === null || actualValue === null ? null : subtract(actualValue, budget);
    // Against the budget's size, so a variance's sign always means above or below the budget.
    const pct = variance === null || budget === null || isZero(budget) ? null : divide(variance, abs(budget));
    const favourable = variance === null ? null
      : line.kind === 'cost' ? !variance.greaterThan(0) : !variance.lessThan(0);

    rows.push({
      key: line.key,
      kind: line.kind,
      derived: line.derived,
      budget: budget === null ? null : toMoneyString(budget),
      // Snapshots store an exact numeric; shown here in the money form the budget uses.
      actual: actualValue === null ? null : toMoneyString(actualValue),
      actualSnapshotId: actual?.snapshotId ?? null,
      actualMissing: actual === null ? ['no_figure'] : actual.missing,
      actualStatusLabel: actual?.statusLabel ?? null,
      variance: variance === null ? null : toMoneyString(variance),
      variancePct: pct === null ? null : toRatioString(pct),
      favourable,
      assumedZero: [...new Set(assumed)],
    });
  }

  const notCompared = [...input.budgetByCategory.entries()]
    .filter(([category]) => !COMPARED_CATEGORIES.has(category))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, budget]) => ({ category, budget: toMoneyString(budget) }));

  return { version: BUDGET_VARIANCE_VERSION, rows, notCompared };
}

/** Σ amounts by category, exact. */
export function budgetByCategory(lines: readonly { readonly category: string; readonly amount: string }[]): Map<string, string> {
  const totals = new Map<string, Decimal>();
  for (const line of lines) totals.set(line.category, add(totals.get(line.category) ?? ZERO, line.amount));
  return new Map([...totals.entries()].map(([category, total]) => [category, toMoneyString(total)]));
}
