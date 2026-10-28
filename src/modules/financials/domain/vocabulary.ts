/**
 * The canonical plain-language vocabulary (`UX_ARCHITECTURE.md §8.1`, ADR-037).
 *
 * §8.1 is "the single table every other document cites", and ADR-037 says the documents that cite it
 * "never restate labels". The same has to be true of the code: the dashboard names a figure on a
 * card and the evidence module names the same figure on an item label, and if those two tables were
 * separate they would drift — the drawer would eventually call something by a name the card does
 * not use, about the same number.
 *
 * `plain` is the headline register ("Sales"); `technical` is the accountant's ("Revenue"), used on
 * Money sub-pages, in evidence and in reports, where somebody may be reconciling (§304).
 *
 * It lives in `financials` because that is the module both the dashboard and evidence already
 * depend on for financial vocabulary, and neither may depend on the other.
 */

/** The plain and technical labels for the metrics Home shows (§8.1). */
export const METRIC_LABELS: Readonly<Record<string, { plain: string; technical: string }>> = {
  revenue: { plain: 'Sales', technical: 'Revenue' },
  gross_profit: { plain: 'Profit after direct costs', technical: 'Gross profit' },
  gross_margin: { plain: 'Margin after direct costs', technical: 'Gross margin' },
  operating_profit: { plain: 'Profit', technical: 'Operating profit — before interest and tax' },
  net_profit: { plain: 'Profit after interest and tax', technical: 'Net profit' },
  operating_margin: { plain: 'Profit margin', technical: 'Operating margin' },
  net_margin: { plain: 'Margin after interest and tax', technical: 'Net margin' },
  closing_cash: { plain: 'Cash', technical: 'Cash in the bank at the end of the month' },
  opening_cash: { plain: 'Cash at the start', technical: 'Opening cash' },
  cash_inflows: { plain: 'Money in', technical: 'Cash inflows' },
  cash_outflows: { plain: 'Money out', technical: 'Cash outflows' },
  net_cash_movement: { plain: 'Change in cash', technical: 'Net cash movement' },
  cash_runway_months: { plain: 'Cash runway', technical: 'Months of cash at the current burn rate' },
  receivables: { plain: 'Owed to you', technical: 'Receivables' },
  receivables_overdue: { plain: 'Overdue to you', technical: 'Overdue receivables' },
  receivables_days: { plain: 'Days to get paid', technical: 'Debtor days' },
  payables: { plain: 'You owe', technical: 'Payables' },
  payables_overdue: { plain: 'Overdue by you', technical: 'Overdue payables' },
  payables_days: { plain: 'Days you take to pay', technical: 'Creditor days' },
  working_capital: { plain: 'Working capital', technical: 'Current assets less current liabilities' },
  // ADR-145 / ADR-156: the balance statement's assets and borrowing.
  debt_balance: { plain: 'Borrowing owed', technical: 'Loans and long-term liabilities' },
  fixed_assets: { plain: 'Fixed assets', technical: 'Fixed assets (property, plant and equipment)' },
  other_long_term_assets: { plain: 'Other long-term assets', technical: 'Other non-current assets' },
  current_assets: { plain: 'Current assets', technical: 'Current assets' },
  total_assets: { plain: 'Total assets', technical: 'Total assets' },
  loan_balance: { plain: 'Loans', technical: 'Loans' },
  long_term_borrowing: { plain: 'Long-term borrowing', technical: 'Long-term liabilities' },
  loans_secured: { plain: 'Secured loans', technical: 'Secured borrowing' },
  loans_unsecured: { plain: 'Unsecured loans', technical: 'Unsecured borrowing' },
  loans_unmarked: { plain: 'Loans not yet marked', technical: 'Borrowing not marked secured or unsecured' },
  operating_expenses: { plain: 'Running costs', technical: 'Operating expenses' },
  cost_of_sales: { plain: 'Direct costs', technical: 'Cost of sales' },
  customer_concentration_top1: {
    plain: 'How much you rely on your biggest customer', technical: 'Customer concentration',
  },
  customer_concentration_top5: {
    plain: 'How much you rely on your five biggest customers', technical: 'Top five customer share',
  },
  revenue_concentration_hhi: { plain: 'How spread out your sales are', technical: 'Revenue concentration (HHI)' },
  customer_revenue: { plain: 'Sales from this customer', technical: 'Revenue by customer' },
  customer_revenue_share: { plain: 'Share of your sales', technical: 'Share of revenue' },
  customer_contribution: { plain: 'Left after their direct costs', technical: 'Contribution by customer' },
  supplier_concentration_top1: {
    plain: 'How much you rely on your biggest supplier', technical: 'Supplier concentration',
  },
  supplier_concentration_top5: {
    plain: 'How much you rely on your five biggest suppliers', technical: 'Top five supplier share',
  },
  supplier_spend: { plain: 'Spent with this supplier', technical: 'Spend by supplier' },
  expense_by_account: { plain: 'Spending by account', technical: 'Expenses by account' },
  expense_by_category: { plain: 'Spending by type', technical: 'Expenses by category' },
  interest_expense: { plain: 'Interest paid', technical: 'Interest expense' },
  tax_expense: { plain: 'Tax', technical: 'Tax expense' },
};

/** A key with no entry still reads as words ("cash_runway" → "Cash runway"), never as a raw key. */
function humanise(key: string): string {
  const words = key.replace(/[_.]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function labelFor(metricKey: string): { plain: string; technical: string } {
  return METRIC_LABELS[metricKey] ?? { plain: humanise(metricKey), technical: humanise(metricKey) };
}

/**
 * The plain-English source line (§8.1, "Basis: …").
 *
 * Rendered as tooltip text and at drawer level 1, never as a badge on a card.
 */
export const BASIS_TEXT: Readonly<Record<string, string>> = {
  bank: 'From bank statements',
  ledger: 'From your accounts',
  invoices: 'From invoices',
  period_balances: 'From your reports',
  mixed: 'From more than one source',
  none: 'No source covers this month',
};

// -----------------------------------------------------------------------------------------------
// Semantic availability (ADR-106)
// -----------------------------------------------------------------------------------------------

/**
 * Whether a figure is ECONOMICALLY ESTABLISHED, as distinct from whether the engine wrote a number
 * for it.
 *
 * The engine's contract (FINANCIAL_ENGINE.md §3.1) is that gross profit IS revenue when the
 * organisation has no cost of sales to subtract, so that the statement still adds up; it says so
 * with the warning `no_cost_of_sales` and a `cost_of_sales` that is NULL with its reason. That
 * number is right as a line in a statement and misleading as a conclusion: "profit after direct
 * costs equals sales" reads as a 100% margin to somebody who simply never recorded their costs.
 *
 * Home has omitted the card since ADR-105. The analyst did not — it was handed £9,000 with
 * `assurance_level: calculated` and `completeness: 1.00`, the same figure dressed as an established
 * conclusion. ADR-106 makes this ONE rule for every surface. It lives here because `financials` is
 * the module both the dashboard and the AI already depend on for financial vocabulary.
 *
 * This is a presentation semantic. It changes nothing the engine calculates or stores.
 */
export type MetricAvailability =
  | { readonly state: 'available' }
  | { readonly state: 'not_applicable'; readonly reason: string };

/** The reasons a cost of sales is absent BY DESIGN rather than merely missing (CD-05, ADR-104). */
export const COST_OF_SALES_ABSENT_CODES: readonly string[] = [
  'no_cost_of_sales_accounts',
  'cost_of_sales_in_other_source',
];

/**
 * The reader's words for each availability reason. Shared so the card, the report and the analyst
 * cannot describe one limitation in two ways (`missingReasonText` spreads this in).
 */
export const AVAILABILITY_REASON_TEXT: Readonly<Record<string, string>> = {
  no_cost_of_sales_accounts: 'You have no direct-cost accounts, so this does not apply.',
  cost_of_sales_in_other_source:
    'Your purchase invoices show direct costs, but the source this month’s figures come from does not, so this cannot be established.',
  // Reachable only where the `cost_of_sales` figure itself was not read, e.g. a trend over months.
  no_cost_of_sales:
    'No cost of sales is recorded on the source this month’s figures come from, so this cannot be established.',
};

/** What a figure carries for this rule: the engine's own value and data-quality codes. */
export interface AvailabilityInput {
  readonly value: string | null;
  readonly warnings: readonly string[];
  readonly missing: readonly string[];
}

/**
 * The one rule. `costOfSales` is the same period's `cost_of_sales` figure where the caller has it:
 * it carries the ACCURATE reason code, which `gross_profit` does not, because the engine strips the
 * absent-by-design code from gross profit's own `missing` (that value is not missing).
 */
export function metricAvailability(
  metricKey: string,
  figure: AvailabilityInput,
  costOfSales?: AvailabilityInput | null,
): MetricAvailability {
  if (metricKey !== 'gross_profit' && metricKey !== 'gross_margin') return { state: 'available' };

  const costAbsentCode = costOfSales != null && costOfSales.value === null
    ? costOfSales.missing.find((code) => COST_OF_SALES_ABSENT_CODES.includes(code))
    : undefined;
  const ownCode = figure.missing.find((code) => COST_OF_SALES_ABSENT_CODES.includes(code));
  const unsupported = figure.warnings.includes('no_cost_of_sales')
    || ownCode !== undefined
    || costAbsentCode !== undefined;
  if (!unsupported) return { state: 'available' };

  // Prefer the reason `cost_of_sales` states, then this figure's own, then the generic one.
  return { state: 'not_applicable', reason: costAbsentCode ?? ownCode ?? 'no_cost_of_sales' };
}
