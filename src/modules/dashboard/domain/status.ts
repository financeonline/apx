/**
 * The canonical status badge (UX_ARCHITECTURE.md §8.1, ADR-037).
 *
 * §4 states the rule that makes this file necessary: **every number carries exactly one status
 * badge — the worst of its assurance level and its data-quality state.** Basis and warnings live in
 * the tooltip and in the evidence drawer, never as extra badges. Two badges on a card would make a
 * reader weigh them against each other, which is precisely the judgement the product is supposed to
 * have made for them.
 *
 * This is the single implementation. `AI_ARCHITECTURE.md §6` and `EVIDENCE_MODEL.md §7` cite the
 * same table, so a second copy anywhere would be a second answer to "how sure are we".
 */

import { AVAILABILITY_REASON_TEXT } from '@/modules/financials';
import type { AssuranceLevel, DataQuality } from '@/modules/financial-engine';

export type StatusKind = 'none' | 'calculated' | 'partial' | 'estimate' | 'check' | 'not_available';

export interface StatusBadge {
  readonly kind: StatusKind;
  /** Absent for `none`: a fully verified figure carries no badge at all. */
  readonly label: string | null;
  readonly tooltip: string;
}

/** The completeness below which a figure is "Partial data", whatever its assurance. */
export const PARTIAL_DATA_THRESHOLD = 0.9;

/**
 * Derives the one badge a figure carries.
 *
 * The order of the tests is the order of §8.1's table, and it is deliberate: a NULL beats
 * everything (there is no figure to qualify), then AI-read, then estimated, then incomplete, then
 * merely calculated. Reordering would let a figure that needs checking be labelled merely
 * "Calculated".
 */
export function statusFor(input: {
  readonly value: string | null;
  readonly assurance: AssuranceLevel;
  readonly dataQuality: DataQuality;
}): StatusBadge {
  const { value, assurance, dataQuality } = input;

  if (value === null) {
    return {
      kind: 'not_available',
      label: '—',
      // The reason is the point: "—" without one is indistinguishable from a bug.
      tooltip: missingReasonText(dataQuality.missing),
    };
  }

  if (assurance === 'inferred') {
    return {
      kind: 'check',
      label: 'Please check',
      // A balance can be `inferred` because an EARLIER month was AI-read and it was carried from it
      // (Step 0D); the evidence drawer names the statement (`rests_on_statements`).
      tooltip: 'Read from a document by AI, or carried from a month that was, and awaiting confirmation',
    };
  }

  if (assurance === 'estimated' || dataQuality.proxy) {
    return {
      kind: 'estimate',
      label: 'Estimate',
      tooltip: 'Estimated from bank activity; may include VAT and timing differences',
    };
  }

  if (dataQuality.completeness < PARTIAL_DATA_THRESHOLD || dataQuality.warnings.length > 0) {
    return {
      kind: 'partial',
      label: 'Partial data',
      tooltip: 'Some data is missing or uncategorised — tap for details',
    };
  }

  if (assurance === 'calculated') {
    return { kind: 'calculated', label: 'Calculated', tooltip: 'Worked out from your records' };
  }

  // `verified` with complete data and no warnings: no badge, because the ordinary case should not
  // be decorated.
  return { kind: 'none', label: null, tooltip: 'From your records' };
}

/** Plain-language reasons for a figure that could not be computed (§4, §8.1). */
const MISSING_REASONS: Readonly<Record<string, string>> = {
  no_source_covers_period: 'We do not have data covering this month yet.',
  no_opening_cash: 'We need the opening bank balance before we can show your cash.',
  no_bank_accounts: 'Add a bank account and upload its statements to see your cash.',
  no_opening_balance: 'We need an opening balance for this account first.',
  no_prior_trial_balance: 'The previous month’s figures are missing, so this cannot be worked out.',
  account_absent_unconfirmed: 'An account appears in one month’s report but not the other’s, and the report does not show it is complete, so this month cannot be worked out.',
  category_not_in_report: 'Your report has no line for this and is only part of your accounts, so we cannot treat it as zero.',
  opening_invoices_unconfirmed: 'Your invoice list may leave out older invoices that were still unpaid, so we cannot show what is owed. Confirm on the import that it includes every unpaid invoice, or add a balance sheet.',
  report_completeness_unconfirmed: 'Your report has no line for this, and nobody has yet confirmed whether the report lists every account. An owner or admin can confirm it on the import.',
  stale_invoice_data: 'Your invoice list does not show the position at the end of this month.',
  vat_basis_unknown: 'What you owe includes VAT but your costs do not, so the days cannot be compared fairly.',
  // The cost-of-sales reasons are the shared ones (ADR-106): Home, the report and the analyst all
  // explain this limitation, and they may not word it differently.
  ...AVAILABILITY_REASON_TEXT,
  comparison_period_missing: 'There is no earlier month to compare with.',
  comparison_is_zero: 'The month being compared with was zero, so a percentage would not mean anything.',
  insufficient_history: 'We need a few more months of data for this.',
  no_counterparty_data: 'We cannot tell which customer this relates to yet.',
  uncategorised_amounts_exceed_threshold: 'Too much is uncategorised for this to be reliable.',
  no_due_dates: 'Your invoices have no due dates, so we cannot tell what is overdue.',
  open_items_only: 'Your invoice list only contains unpaid invoices, so this cannot be worked out.',
  partial_month: 'This month is not finished yet.',
};

export function missingReasonText(missing: readonly string[]): string {
  for (const reason of missing) {
    const text = MISSING_REASONS[reason];
    if (text) return text;
  }
  return 'We do not have enough data to show this yet.';
}

/** Re-exported, not restated: the canonical §8.1 table lives in `modules/financials` (ADR-037). */
export { BASIS_TEXT } from '@/modules/financials';
