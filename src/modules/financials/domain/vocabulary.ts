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
  operating_expenses: { plain: 'Running costs', technical: 'Operating expenses' },
  cost_of_sales: { plain: 'Direct costs', technical: 'Cost of sales' },
  customer_concentration_top1: {
    plain: 'How much you rely on your biggest customer', technical: 'Customer concentration',
  },
};

export function labelFor(metricKey: string): { plain: string; technical: string } {
  return METRIC_LABELS[metricKey] ?? { plain: metricKey, technical: metricKey };
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
