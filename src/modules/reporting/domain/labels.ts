import type { InterimFigureKey } from '@/modules/financial-engine';
import type { HealthDimensionKey } from '@/modules/health';

/**
 * The words the composed reports use (Phase 17), shared by the page and the PDF so the two say the
 * same thing.
 *
 * The health-dimension names and exclusion reasons repeat `components/dashboard/health-presentation`
 * because a module may not import from components (ADR-022); `test/unit/report-labels.test.ts`
 * asserts they are identical, so they cannot drift apart.
 */

export const INTERIM_LABELS: Readonly<Record<InterimFigureKey, string>> = {
  cash_in: 'Money in',
  cash_out: 'Money out',
  net_cash_movement: 'Net cash movement',
  sales_invoiced: 'Sales invoiced',
  purchases_invoiced: 'Bills received',
  sales_collected: 'Invoices paid by customers',
  purchases_paid: 'Bills paid',
  sales_fell_due_unpaid: 'Customer invoices that fell due unpaid',
  purchases_fell_due_unpaid: 'Bills that fell due unpaid',
};

/** One line under each interim figure saying exactly what it counts. */
export const INTERIM_NOTES: Readonly<Record<InterimFigureKey, string>> = {
  cash_in: 'Bank transactions dated in the period; transfers between your own accounts are left out.',
  cash_out: 'Bank transactions dated in the period; transfers between your own accounts are left out.',
  net_cash_movement: 'Money in less money out.',
  sales_invoiced: 'Sales invoices issued in the period, less credit notes.',
  purchases_invoiced: 'Supplier bills dated in the period, less credit notes.',
  sales_collected: 'Sales invoices fully paid on a date in the period. A part payment has no date and is not counted.',
  purchases_paid: 'Supplier bills fully paid on a date in the period. A part payment has no date and is not counted.',
  sales_fell_due_unpaid: 'Due in the period and still unpaid when this report was produced, by the amount still owed.',
  purchases_fell_due_unpaid: 'Due in the period and still unpaid when this report was produced, by the amount still owed.',
};

export const INTERIM_STATUS_LABELS = {
  calculated: 'Calculated',
  incomplete: 'Incomplete',
} as const;

/** The interim figures are not the monthly engine's; every report that shows them says so. */
export const INTERIM_DISCLAIMER =
  'Day and week figures are early figures: they count only the statements and invoices added so far, '
  + 'and will change as more arrive. The month section uses the finished monthly figures.';

export const SEVERITY_LABELS = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info',
} as const;

export const PRIORITY_LABELS = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
} as const;

export const REPORT_DIMENSION_LABELS: Readonly<Record<HealthDimensionKey, string>> = {
  profitability: 'Profitability',
  cash_flow: 'Cash',
  revenue_growth: 'Sales growth',
  cost_control: 'Costs',
  customer_quality: 'Customers',
  banking_health: 'Banking',
  marketing_efficiency: 'Marketing',
  funding_readiness: 'Funding readiness',
};

export const REPORT_EXCLUSION_TEXT: Readonly<Record<string, string>> = {
  required_metric_missing: 'Not scored — we do not have the figures this needs yet.',
  insufficient_completeness: 'Not scored — we can see too little of this month to judge it.',
  no_bank_coverage: 'Not scored — no bank statement covers this month.',
  no_campaign_data: 'Not scored — no campaign spend is recorded for the last three months.',
};

/** "7 September 2026", or "7–13 September 2026" for a week (en-GB, as the product writes dates). */
export function windowLabel(start: string, end: string): string {
  const fmt = (iso: string, parts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { ...parts, timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  // Weekday and date composed separately: ICU's en-GB puts a comma after the weekday in some
  // runtimes and not others.
  if (start === end) return `${fmt(start, { weekday: 'long' })} ${fmt(start, { day: 'numeric', month: 'long', year: 'numeric' })}`;
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return sameMonth
    ? `${fmt(start, { day: 'numeric' })}–${fmt(end, { day: 'numeric', month: 'long', year: 'numeric' })}`
    : `${fmt(start, { day: 'numeric', month: 'long' })} – ${fmt(end, { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

/*
 * The analyst's words, for the Custom AI Report's PDF. Copies of
 * `components/dashboard/analyst-presentation` (a module may not import components, ADR-022);
 * `test/unit/report-labels.test.ts` asserts they are identical.
 */
export const STATEMENT_KIND_LABELS: Readonly<Record<string, string>> = {
  verified_fact: 'Fact',
  deterministic_calculation: 'Calculated',
  estimate: 'Estimate',
  inference: 'Analysis',
  recommendation: 'Recommendation',
};

export const ANSWER_SECTION_TITLES = {
  key_findings: 'Key findings',
  causes: 'What is behind it',
  risks: 'Risks',
  opportunities: 'Opportunities',
  recommended_actions: 'Recommended actions',
} as const;

export const UNSUPPORTED_TEXT: Readonly<Record<string, string>> = {
  no_data: 'no figures for that',
  not_in_scope: 'outside what the analyst covers',
  unverified: 'figure could not be verified',
  ambiguous_period: 'which period was meant is unclear',
  permission: 'not available to your role',
};

export const NOTE_TEXT: Readonly<Record<string, string>> = {
  cash_basis_proxy: 'figures are estimated from bank activity, not from your accounts',
  vat_inclusive: 'bank figures may include VAT',
  uncategorised_amounts: 'some amounts are not yet categorised',
  bank_coverage_partial: 'bank statements do not cover the whole period',
  partial_month: 'the month is not complete',
  no_cost_of_sales: 'no direct-cost accounts, so no margin after direct costs',
  no_source_covers_period: 'no data covers that period',
  comparison_period_missing: 'nothing to compare with yet',
  insufficient_history: 'not enough history yet',
  no_counterparty_data: 'no customer or supplier detail in the data',
  stale_invoice_data: 'invoice data is out of date',
  basis_differs: 'the two periods come from different sources',
};

export const DEGRADED_TEXT = "Some of this answer couldn't be verified against your data, so we've left it out.";
export const UNANSWERED_TEXT = 'The analyst could not answer this question, so there is nothing to show for it.';
