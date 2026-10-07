/**
 * The metric registry (FINANCIAL_ENGINE.md §3.6).
 *
 * Every metric key the engine can produce is declared here exactly once. This is the source for the
 * UI's labels and "what is this?" copy, for the AI's `get_metric` catalogue, and for the dependency
 * order the run computes in. **An unknown metric key is a type error**, which is what stops a
 * dashboard tile or an AI answer quoting a number nobody defined.
 *
 * `label` matters more than it looks: the AI grounding check requires the label to appear near a
 * quoted figure (ADR-045.1), so a wrong label is a grounding failure, not a cosmetic bug.
 */

import type { DimensionType, MetricFamily, MetricUnit } from './types';

/** How a monthly key rolls up to a quarter or a year (§3.6). */
export type Aggregation = 'sum' | 'last' | 'recompute';

export interface MetricDefinition {
  readonly key: string;
  readonly label: string;
  /** One sentence, plain language, for the "What is this?" copy. */
  readonly description: string;
  readonly unit: MetricUnit;
  readonly family: MetricFamily;
  /**
   * Dependency level. L0 is the SQL aggregate; a metric may only read levels strictly below it,
   * which is what makes the computation order a topological sort rather than a guess.
   */
  readonly level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  readonly dimensionType: DimensionType;
  readonly dependencies: readonly string[];
  readonly aggregation: Aggregation;
  /**
   * True when the value depends on "today" rather than only on the period's records — aging,
   * overdue, runway. A daily scheduled run recomputes exactly these for the current period and
   * nothing else (ADR-047.8), which is why the flag lives here and not in the run code.
   */
  readonly asOfDependent: boolean;
}

function define(d: MetricDefinition): MetricDefinition {
  return d;
}

// ---------------------------------------------------------------------------------------------
// Profit and loss (§3.1)
// ---------------------------------------------------------------------------------------------
const PNL: readonly MetricDefinition[] = [
  define({
    key: 'revenue', label: 'Revenue',
    description: 'What the business earned from its normal trading in this month, before any costs.',
    unit: 'money', family: 'pnl', level: 1, dimensionType: 'none',
    dependencies: [], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'other_income', label: 'Other income',
    description: 'Income from outside normal trading, such as interest received or a one-off sale.',
    unit: 'money', family: 'pnl', level: 1, dimensionType: 'none',
    dependencies: [], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'cost_of_sales', label: 'Cost of sales',
    description: 'The direct cost of what was sold: materials, stock and subcontractors.',
    unit: 'money', family: 'pnl', level: 1, dimensionType: 'none',
    dependencies: [], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'gross_profit', label: 'Gross profit',
    description: 'Revenue less the direct cost of what was sold.',
    unit: 'money', family: 'pnl', level: 2, dimensionType: 'none',
    dependencies: ['revenue', 'cost_of_sales'], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'gross_margin', label: 'Gross margin',
    description: 'Gross profit as a share of revenue.',
    unit: 'ratio', family: 'pnl', level: 3, dimensionType: 'none',
    dependencies: ['gross_profit', 'revenue'], aggregation: 'recompute', asOfDependent: false,
  }),
  define({
    key: 'expense_by_category', label: 'Spending by category',
    description: 'What was spent in this month, grouped into standard categories.',
    unit: 'money', family: 'pnl', level: 1, dimensionType: 'standard_category',
    dependencies: [], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'expense_by_account', label: 'Spending by account',
    description: 'What was spent in this month, grouped by the account in your chart of accounts.',
    unit: 'money', family: 'pnl', level: 1, dimensionType: 'account',
    dependencies: [], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'operating_expenses', label: 'Operating expenses',
    description: 'The running costs of the business: overheads, payroll, marketing and depreciation.',
    unit: 'money', family: 'pnl', level: 2, dimensionType: 'none',
    dependencies: ['expense_by_category'], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'operating_profit', label: 'Operating profit',
    description: 'Gross profit less the running costs of the business.',
    unit: 'money', family: 'pnl', level: 3, dimensionType: 'none',
    dependencies: ['gross_profit', 'operating_expenses'], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'operating_margin', label: 'Operating margin',
    description: 'Operating profit as a share of revenue.',
    unit: 'ratio', family: 'pnl', level: 4, dimensionType: 'none',
    dependencies: ['operating_profit', 'revenue'], aggregation: 'recompute', asOfDependent: false,
  }),
  define({
    key: 'other_expense', label: 'Other costs',
    description: 'Costs outside normal trading.',
    unit: 'money', family: 'pnl', level: 1, dimensionType: 'none',
    dependencies: [], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'interest_expense', label: 'Interest paid',
    description: 'Interest and bank charges on borrowing.',
    unit: 'money', family: 'pnl', level: 1, dimensionType: 'none',
    dependencies: [], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'tax_expense', label: 'Tax',
    description: 'Tax charged against this month.',
    unit: 'money', family: 'pnl', level: 1, dimensionType: 'none',
    dependencies: [], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'net_profit', label: 'Net profit',
    description: 'What is left after every cost, including interest and tax.',
    unit: 'money', family: 'pnl', level: 4, dimensionType: 'none',
    dependencies: ['operating_profit', 'other_income', 'other_expense', 'interest_expense', 'tax_expense'],
    aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'net_margin', label: 'Net margin',
    description: 'Net profit as a share of revenue.',
    unit: 'ratio', family: 'pnl', level: 5, dimensionType: 'none',
    dependencies: ['net_profit', 'revenue'], aggregation: 'recompute', asOfDependent: false,
  }),
  define({
    key: 'contribution_margin', label: 'Contribution',
    description: 'Revenue less the costs that rise and fall with sales.',
    unit: 'money', family: 'pnl', level: 2, dimensionType: 'none',
    dependencies: ['revenue', 'cost_of_sales', 'expense_by_category'], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'contribution_margin_ratio', label: 'Contribution margin',
    description: 'Contribution as a share of revenue.',
    unit: 'ratio', family: 'pnl', level: 3, dimensionType: 'none',
    dependencies: ['contribution_margin', 'revenue'], aggregation: 'recompute', asOfDependent: false,
  }),
];

// ---------------------------------------------------------------------------------------------
// Cash (§3.3)
// ---------------------------------------------------------------------------------------------
const CASH: readonly MetricDefinition[] = [
  define({
    key: 'cash_inflows', label: 'Money in',
    description: 'Money that came into the bank accounts this month, excluding transfers between them.',
    unit: 'money', family: 'cash', level: 1, dimensionType: 'none',
    dependencies: [], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'cash_outflows', label: 'Money out',
    description: 'Money that left the bank accounts this month, excluding transfers between them.',
    unit: 'money', family: 'cash', level: 1, dimensionType: 'none',
    dependencies: [], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'net_cash_movement', label: 'Net cash movement',
    description: 'Money in less money out for the month.',
    unit: 'money', family: 'cash', level: 2, dimensionType: 'none',
    dependencies: ['cash_inflows', 'cash_outflows'], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'opening_cash', label: 'Cash at the start',
    description: 'The bank balance at the start of the month.',
    unit: 'money', family: 'cash', level: 2, dimensionType: 'none',
    dependencies: [], aggregation: 'last', asOfDependent: false,
  }),
  define({
    key: 'closing_cash', label: 'Cash at the end',
    description: 'The bank balance at the end of the month.',
    unit: 'money', family: 'cash', level: 3, dimensionType: 'none',
    dependencies: ['opening_cash', 'net_cash_movement'], aggregation: 'last', asOfDependent: false,
  }),
  define({
    key: 'cash_runway_months', label: 'Cash runway',
    description: 'How many months the current cash would last at the recent rate of spending.',
    unit: 'count', family: 'cash', level: 4, dimensionType: 'none',
    dependencies: ['closing_cash', 'net_cash_movement'], aggregation: 'recompute', asOfDependent: true,
  }),
];

// ---------------------------------------------------------------------------------------------
// Receivables, payables and working capital (§3.4)
// ---------------------------------------------------------------------------------------------
const RECEIVABLES: readonly MetricDefinition[] = [
  define({
    key: 'receivables', label: 'Owed to you',
    description: 'The total still unpaid on sales invoices.',
    unit: 'money', family: 'receivables_payables', level: 1, dimensionType: 'none',
    dependencies: [], aggregation: 'last', asOfDependent: false,
  }),
  define({
    key: 'receivables_overdue', label: 'Overdue to you',
    description: 'The part of what you are owed that is past its due date.',
    unit: 'money', family: 'receivables_payables', level: 2, dimensionType: 'none',
    dependencies: ['receivables'], aggregation: 'last', asOfDependent: true,
  }),
  define({
    key: 'receivables_days', label: 'Days to get paid',
    description: 'Roughly how long customers take to pay, in days.',
    unit: 'days', family: 'receivables_payables', level: 3, dimensionType: 'none',
    dependencies: ['receivables', 'revenue'], aggregation: 'recompute', asOfDependent: true,
  }),
  define({
    key: 'payables', label: 'You owe',
    description: 'The total still unpaid on supplier invoices.',
    unit: 'money', family: 'receivables_payables', level: 1, dimensionType: 'none',
    dependencies: [], aggregation: 'last', asOfDependent: false,
  }),
  define({
    key: 'payables_overdue', label: 'Overdue by you',
    description: 'The part of what you owe that is past its due date.',
    unit: 'money', family: 'receivables_payables', level: 2, dimensionType: 'none',
    dependencies: ['payables'], aggregation: 'last', asOfDependent: true,
  }),
  define({
    key: 'payables_days', label: 'Days you take to pay',
    description: 'Roughly how long you take to pay suppliers, in days.',
    unit: 'days', family: 'receivables_payables', level: 3, dimensionType: 'none',
    dependencies: ['payables', 'cost_of_sales', 'operating_expenses'],
    aggregation: 'recompute', asOfDependent: true,
  }),
  define({
    // Phase 16 (ADR-145): read only by Funding Readiness.
    key: 'debt_balance', label: 'Borrowing owed',
    description: 'What the business owes on loans and long-term borrowing at the month end, from a trial balance or balance sheet.',
    unit: 'money', family: 'receivables_payables', level: 2, dimensionType: 'none',
    dependencies: [], aggregation: 'last', asOfDependent: false,
  }),
  define({
    // ADR-156: from the balance family's statement, as debt_balance.
    key: 'fixed_assets', label: 'Fixed assets',
    description: 'Property, equipment and other fixed assets at the month end, from a trial balance or balance sheet.',
    unit: 'money', family: 'receivables_payables', level: 2, dimensionType: 'none',
    dependencies: [], aggregation: 'last', asOfDependent: false,
  }),
  define({
    // ADR-156: from the balance family's statement, as debt_balance.
    key: 'other_long_term_assets', label: 'Other long-term assets',
    description: 'Other assets held for more than a year, at the month end.',
    unit: 'money', family: 'receivables_payables', level: 2, dimensionType: 'none',
    dependencies: [], aggregation: 'last', asOfDependent: false,
  }),
  define({
    // ADR-156: from the balance family's statement, as debt_balance.
    key: 'current_assets', label: 'Current assets',
    description: 'Cash, what customers owe, stock and other short-term assets at the month end.',
    unit: 'money', family: 'receivables_payables', level: 2, dimensionType: 'none',
    dependencies: [], aggregation: 'last', asOfDependent: false,
  }),
  define({
    // ADR-156: from the balance family's statement, as debt_balance.
    key: 'total_assets', label: 'Total assets',
    description: 'Fixed, other long-term and current assets together at the month end.',
    unit: 'money', family: 'receivables_payables', level: 2, dimensionType: 'none',
    dependencies: [], aggregation: 'last', asOfDependent: false,
  }),
  define({
    // ADR-156: from the balance family's statement, as debt_balance.
    key: 'loan_balance', label: 'Loans',
    description: 'What is owed on accounts categorised as loans at the month end.',
    unit: 'money', family: 'receivables_payables', level: 2, dimensionType: 'none',
    dependencies: [], aggregation: 'last', asOfDependent: false,
  }),
  define({
    // ADR-156: from the balance family's statement, as debt_balance.
    key: 'long_term_borrowing', label: 'Long-term borrowing',
    description: 'What is owed on accounts categorised as long-term liabilities at the month end.',
    unit: 'money', family: 'receivables_payables', level: 2, dimensionType: 'none',
    dependencies: [], aggregation: 'last', asOfDependent: false,
  }),
  define({
    // ADR-156: from the balance family's statement, as debt_balance.
    key: 'loans_secured', label: 'Secured loans',
    description: 'Borrowing on accounts you marked as secured, at the month end.',
    unit: 'money', family: 'receivables_payables', level: 2, dimensionType: 'none',
    dependencies: [], aggregation: 'last', asOfDependent: false,
  }),
  define({
    // ADR-156: from the balance family's statement, as debt_balance.
    key: 'loans_unsecured', label: 'Unsecured loans',
    description: 'Borrowing on accounts you marked as unsecured, at the month end.',
    unit: 'money', family: 'receivables_payables', level: 2, dimensionType: 'none',
    dependencies: [], aggregation: 'last', asOfDependent: false,
  }),
  define({
    // ADR-156: from the balance family's statement, as debt_balance.
    key: 'loans_unmarked', label: 'Loans not yet marked',
    description: 'Borrowing on accounts not yet marked secured or unsecured, at the month end.',
    unit: 'money', family: 'receivables_payables', level: 2, dimensionType: 'none',
    dependencies: [], aggregation: 'last', asOfDependent: false,
  }),
  define({
    key: 'working_capital', label: 'Working capital',
    description: 'Short-term assets less short-term liabilities: what the business has to work with.',
    unit: 'money', family: 'derived', level: 4, dimensionType: 'none',
    dependencies: ['closing_cash', 'receivables', 'payables'], aggregation: 'last', asOfDependent: false,
  }),
];

// ---------------------------------------------------------------------------------------------
// Customers and suppliers (§3.5)
// ---------------------------------------------------------------------------------------------
const COUNTERPARTY: readonly MetricDefinition[] = [
  define({
    key: 'customer_revenue', label: 'Revenue by customer',
    description: 'How much of this month’s revenue came from each customer.',
    unit: 'money', family: 'counterparty', level: 2, dimensionType: 'counterparty',
    dependencies: ['revenue'], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'customer_contribution', label: 'Contribution by customer',
    description: 'Revenue from a customer less the costs directly attributed to them.',
    unit: 'money', family: 'counterparty', level: 3, dimensionType: 'counterparty',
    dependencies: ['customer_revenue'], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'customer_revenue_share', label: 'Share of revenue',
    description: 'What share of revenue each customer accounts for.',
    unit: 'ratio', family: 'counterparty', level: 3, dimensionType: 'counterparty',
    dependencies: ['customer_revenue', 'revenue'], aggregation: 'recompute', asOfDependent: false,
  }),
  define({
    key: 'customer_concentration_top1', label: 'Largest customer share',
    description: 'The share of revenue coming from your single largest customer.',
    unit: 'ratio', family: 'counterparty', level: 4, dimensionType: 'none',
    dependencies: ['customer_revenue_share'], aggregation: 'recompute', asOfDependent: false,
  }),
  define({
    key: 'customer_concentration_top5', label: 'Top five customer share',
    description: 'The combined share of revenue from your five largest customers.',
    unit: 'ratio', family: 'counterparty', level: 4, dimensionType: 'none',
    dependencies: ['customer_revenue_share'], aggregation: 'recompute', asOfDependent: false,
  }),
  define({
    key: 'revenue_concentration_hhi', label: 'Revenue concentration',
    description: 'How concentrated revenue is across customers, from 0 (spread evenly) to 1 (a single customer).',
    unit: 'ratio', family: 'counterparty', level: 4, dimensionType: 'none',
    dependencies: ['customer_revenue_share'], aggregation: 'recompute', asOfDependent: false,
  }),
  define({
    key: 'supplier_spend', label: 'Spending by supplier',
    description: 'How much was spent with each supplier this month.',
    unit: 'money', family: 'counterparty', level: 2, dimensionType: 'counterparty',
    dependencies: [], aggregation: 'sum', asOfDependent: false,
  }),
  define({
    key: 'supplier_concentration_top1', label: 'Largest supplier share',
    description: 'The share of spending going to your single largest supplier.',
    unit: 'ratio', family: 'counterparty', level: 4, dimensionType: 'none',
    dependencies: ['supplier_spend'], aggregation: 'recompute', asOfDependent: false,
  }),
  define({
    key: 'supplier_concentration_top5', label: 'Top five supplier share',
    description: 'The combined share of spending going to your five largest suppliers.',
    unit: 'ratio', family: 'counterparty', level: 4, dimensionType: 'none',
    dependencies: ['supplier_spend'], aggregation: 'recompute', asOfDependent: false,
  }),
];

/** Growth metrics written as their own keys for convenience (§3.2). */
const GROWTH: readonly MetricDefinition[] = [
  define({
    key: 'revenue_growth_mom', label: 'Revenue growth on last month',
    description: 'How revenue compares with the month before, as a percentage.',
    unit: 'ratio', family: 'pnl', level: 6, dimensionType: 'none',
    dependencies: ['revenue'], aggregation: 'recompute', asOfDependent: false,
  }),
  define({
    key: 'revenue_growth_yoy', label: 'Revenue growth on last year',
    description: 'How revenue compares with the same month a year ago, as a percentage.',
    unit: 'ratio', family: 'pnl', level: 6, dimensionType: 'none',
    dependencies: ['revenue'], aggregation: 'recompute', asOfDependent: false,
  }),
];

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  ...PNL, ...CASH, ...RECEIVABLES, ...COUNTERPARTY, ...GROWTH,
];

const BY_KEY = new Map(METRIC_DEFINITIONS.map((d) => [d.key, d]));

export type MetricKey = string;

export function metricDefinition(key: string): MetricDefinition {
  const definition = BY_KEY.get(key);
  if (!definition) {
    // A key nobody declared cannot be labelled, described, rolled up or grounded. Failing here is
    // the point of the registry.
    throw new Error(`Unknown metric key "${key}". Declare it in domain/registry.ts.`);
  }
  return definition;
}

export function isMetricKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** The base metrics §3.2 writes variances for. */
export const VARIANCE_BASES: readonly string[] = [
  'revenue', 'gross_profit', 'gross_margin', 'operating_expenses', 'operating_profit',
  'net_profit', 'net_margin', 'closing_cash', 'net_cash_movement', 'receivables', 'payables',
  'expense_by_category', 'expense_by_account',
];

export const VARIANCE_SUFFIXES = ['prev_period', 'same_period_last_year', 'trailing_3m_avg'] as const;
export type VarianceSuffix = (typeof VARIANCE_SUFFIXES)[number];

export function varianceKey(base: string, suffix: VarianceSuffix): string {
  return `${base}.variance.${suffix}`;
}

/**
 * The keys a daily scheduled run recomputes for the current period, and nothing else (ADR-047.8).
 * Deriving this from the registry rather than hard-coding it means adding an as-of-dependent metric
 * cannot forget to add it here.
 */
export const AS_OF_DEPENDENT_KEYS: readonly string[] =
  METRIC_DEFINITIONS.filter((d) => d.asOfDependent).map((d) => d.key);

/**
 * Metric keys in dependency order. Level ordering makes this a total order over the levels, and the
 * key ordering inside a level is alphabetical so the computation order — and therefore the written
 * snapshot order — is deterministic.
 */
export const COMPUTATION_ORDER: readonly string[] = [...METRIC_DEFINITIONS]
  .sort((a, b) => (a.level - b.level) || a.key.localeCompare(b.key))
  .map((d) => d.key);
