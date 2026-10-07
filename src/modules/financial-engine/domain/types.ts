/**
 * The engine's type contract (FINANCIAL_ENGINE.md §1–§5).
 *
 * Every function in `domain/` is a function of typed inputs to typed outputs. No Supabase, no
 * Next.js, no clock, no randomness — "today" is an explicit `asOf` input used only for aging and
 * runway. That is what makes the guarantee in §1.1 checkable: the same accepted records, the same
 * engine version and the same settings must produce byte-identical snapshots.
 *
 * Money and ratios are STRINGS at every boundary (ADR-006). A JavaScript number cannot hold 0.1+0.2,
 * and a rounding error in a published financial figure is not a cosmetic bug. Arithmetic happens in
 * `Decimal`; rounding happens exactly once, at snapshot write.
 */

import type { StandardCategory } from '@/modules/financials';

// ---------------------------------------------------------------------------------------------
// Sources, bases and assurance (§2)
// ---------------------------------------------------------------------------------------------

/** Which record table a figure came from. `none` means nothing covered the period. */
export type MetricBasis = 'period_balances' | 'ledger' | 'invoices' | 'bank' | 'mixed' | 'none';

import type { AssuranceLevel } from '@/core/assurance';

export type { AssuranceLevel };

export type MetricUnit = 'money' | 'ratio' | 'count' | 'days';

export type MetricFamily =
  | 'pnl' | 'cash' | 'receivables_payables' | 'counterparty' | 'derived';

export type DimensionType =
  'none' | 'account' | 'standard_category' | 'counterparty' | 'bank_account';

// ---------------------------------------------------------------------------------------------
// Data quality (§5). The vocabulary is closed: an unknown warning is a type error, because a
// warning nobody can render is a warning nobody sees.
// ---------------------------------------------------------------------------------------------

export const DATA_QUALITY_WARNINGS = [
  'cash_basis_proxy', 'vat_inclusive', 'card_spend_unclassified', 'account_absent_prior',
  'open_items_only', 'uncategorised_amounts', 'bank_coverage_partial',
  // NF-7: some categories are zero only because the report was confirmed as listing every account.
  'zero_by_completeness',
  'statement_balance_mismatch', 'unreconciled_statement', 'basis_differs', 'sign_change',
  'new_in_period', 'partial_working_capital', 'no_due_dates', 'payment_date_unknown',
  'fewer_than_5', 'high_unattributed_share', 'negative_revenue', 'unpaired_transfer_candidate',
  'partial_month', 'no_cost_of_sales', 'cash_positive', 'no_cost_allocation',
  /** N-1 (Step 0F): P's balance report is incomplete (not attested), so a ledger or invoice source stated the P&L. */
  'balance_report_incomplete',
  /** Phase 16 (ADR-145): debt accounts carry a debit balance; reported, treated as no debt. */
  'debit_balance_on_debt_accounts',
] as const;
export type DataQualityWarning = (typeof DATA_QUALITY_WARNINGS)[number];

export const DATA_QUALITY_MISSING = [
  'no_source_covers_period', 'no_opening_cash', 'no_opening_balance', 'no_prior_trial_balance',
  'stale_invoice_data', 'no_cost_of_sales_accounts', 'comparison_period_missing',
  'comparison_is_zero', 'insufficient_history', 'no_counterparty_data',
  'uncategorised_amounts_exceed_threshold', 'no_due_dates', 'open_items_only',
  'partial_month',
  /** No cash-like bank account exists, so nothing can establish cash (ADR-104). */
  'no_bank_accounts',
  /**
   * Step 0E: an account appears in one month's cumulative report and not in the other's, and that
   * report does not establish its own completeness (a trial balance that balances), so its absence is
   * not known to mean zero.
   */
  'account_absent_unconfirmed',
  // Step 0F: a report category with no line, where nobody has yet said whether the report is complete.
  'report_completeness_unconfirmed',
  // R-2: a full invoice list nobody has confirmed holds the invoices still unpaid at its start.
  'opening_invoices_unconfirmed',
  // NF-6: a cumulative month whose PRIOR month's report is not complete; a trial balance answered
  // complete whose lines do not balance.
  'prior_report_not_complete', 'trial_balance_not_balanced',
  /**
   * N-1 (Step 0F): P's balance report has no line in this P&L category and does not establish its
   * completeness (no attestation, IMP-TB-016), so the category is unknown — never an inferred zero.
   */
  'category_not_in_report',
  /** Cost of sales exists in a source the chosen P&L basis is not reading (ADR-104). */
  'cost_of_sales_in_other_source',
  /**
   * FU-9 (ADR-129): a ratio's two sides are not on the same VAT footing and no recorded tax data can
   * put them on one — VAT-inclusive payables over VAT-exclusive costs, or a VAT status nobody set.
   */
  'vat_basis_unknown',
  /** Phase 16 (ADR-145): no cumulative trial balance or balance sheet states P, so debt is unknown. */
  'no_balance_sheet',
] as const;
export type DataQualityMissing = (typeof DATA_QUALITY_MISSING)[number];

export interface DataQuality {
  /** 0–1. What share of the underlying figures the engine could actually see (§5). */
  readonly completeness: number;
  /** True when the figure stands in for something it is not — a cash proxy for an accrual number. */
  readonly proxy: boolean;
  readonly warnings: readonly DataQualityWarning[];
  /** Why a NULL is NULL. A value may be present AND carry a missing reason (e.g. account_absent_prior). */
  readonly missing: readonly DataQualityMissing[];
}

export const PERFECT_QUALITY: DataQuality = {
  completeness: 1, proxy: false, warnings: [], missing: [],
};

// ---------------------------------------------------------------------------------------------
// Evidence descriptors (§3 shorthand, EVIDENCE_MODEL.md §3)
// ---------------------------------------------------------------------------------------------

/**
 * The descriptor a leaf metric stores.
 *
 * `standard_categories` is deliberately absent: a category is a mutable property of an account, so a
 * stored category filter would make old evidence follow later remaps (ADR-034). The engine resolves
 * categories to concrete account ids AT RUN TIME and stores those.
 */
export interface LeafDescriptor {
  readonly v: 1;
  readonly table: 'ledger_entries' | 'bank_transactions' | 'invoices' | 'period_balances' | 'metric_snapshots';
  readonly filters: {
    readonly period_ids?: readonly string[];
    readonly account_ids?: readonly string[];
    readonly category_account_ids?: readonly string[];
    readonly counterparty_ids?: readonly string[];
    readonly bank_account_ids?: readonly string[];
    readonly invoice_types?: readonly string[];
    readonly direction?: 'debit' | 'credit' | 'inflow' | 'outflow';
    /** 'all' for the bank-basis P&L proxy; 'cash_only' for cash metrics (ADR-051). */
    readonly exclude_transfers?: 'all' | 'cash_only';
    readonly exclude_cash_transfers?: boolean;
    readonly open_as_of?: string;
    readonly overdue_as_of?: string;
    /** The one statement kind a balance selection reads (ADR-123). */
    readonly balance_kind?: 'trial_balance' | 'pnl_report' | 'balance_sheet';
  };
  readonly as_of: { readonly calculation_run_id: string; readonly aggregated_at: string };
  readonly order?: ReadonlyArray<{ field: string; dir: 'asc' | 'desc' }>;
  readonly limit?: number;
}

/**
 * One side of a figure that is a DIFFERENCE of two months' records (Step 0E): a cumulative trial
 * balance's or P&L report's month is year-to-date(P) − year-to-date(P−1) (§3). Each term names its own
 * records; a term that cannot be read names why instead (`descriptor` NULL, `unavailable` set).
 */
export interface DifferenceTerm {
  /** D-6: `opening_balance` + `movements` is the other two-selection figure (a statement-anchored ledger). */
  readonly name: 'year_to_date' | 'prior_year_to_date' | 'opening_balance' | 'movements';
  /** +1 for the minuend, −1 for the subtrahend: figure = Σ sign × total(term). */
  readonly sign: 1 | -1;
  readonly period_id: string | null;
  readonly descriptor: LeafDescriptor | null;
  readonly unavailable: DataQualityMissing | null;
  /**
   * N-2 (Step 0F): what this term's records total, in reporting sign, as the engine read them — the
   * value the drawer reconciles the term's own records against before it reconciles the formula.
   * NULL when the term is unavailable.
   */
  readonly expected: string | null;
}

export type EvidenceQuery =
  | { readonly kind: 'leaf'; readonly descriptor: LeafDescriptor }
  /** A derived metric points at the snapshots it was computed from, so a reader can descend. */
  | { readonly kind: 'derived'; readonly components: ReadonlyArray<{ name: string; snapshot_id: string | null }> }
  /**
   * Step 0E: a figure that is the difference of two periods' records (§3 cumulative differencing).
   * No single row selection totals to it (ADR-109), so both selections and the formula are stated.
   */
  | {
      readonly kind: 'difference';
      readonly formula: 'year_to_date - prior_year_to_date' | 'opening_balance + movements';
      readonly terms: readonly DifferenceTerm[];
    };

// ---------------------------------------------------------------------------------------------
// The unit of engine output
// ---------------------------------------------------------------------------------------------

/**
 * One computed figure.
 *
 * `value === null` means NOT COMPUTABLE, and is always accompanied by a reason in
 * `data_quality.missing`. It never means zero — zero means "we know it is zero" (§1.5). Confusing
 * the two is how a dashboard tells somebody their revenue was nil when in truth nobody uploaded it.
 */
export interface MetricResult {
  /**
   * The id this snapshot will be written with, minted by the run BEFORE composition (ADR-059).
   *
   * A derived metric's `evidenceQuery` names its inputs by snapshot id, and it is composed while the
   * figures are being worked out — before any row exists. Letting the database generate the ids
   * meant every derived metric was written saying "I came from revenue and cost of sales" and
   * unable to say which ones, which is the entire content of drawer levels 2 and 3.
   */
  readonly id?: string;
  readonly key: string;
  readonly value: string | null;
  readonly unit: MetricUnit;
  readonly basis: MetricBasis;
  readonly assurance: AssuranceLevel;
  readonly dimensionType: DimensionType;
  /** A row id, for the dimensions that are rows. NULL for `none` and `standard_category`. */
  readonly dimensionId: string | null;
  /**
   * The dimension identifier when it is NOT a row — a standard category name. `dimension_id` is a
   * uuid column, and a category has no row to point at, which is also why `same_org_ref` skips that
   * discriminator (ADR-053).
   */
  readonly dimensionKey?: string | null;
  readonly currency: string | null;
  /** Named inputs with their values, so a reader can redo the arithmetic by hand (§1.7). */
  readonly components: Readonly<Record<string, unknown>>;
  readonly dataQuality: DataQuality;
  readonly evidenceQuery: EvidenceQuery | null;
}

// ---------------------------------------------------------------------------------------------
// L0: what the SQL aggregation returns (§2.4 step 4)
// ---------------------------------------------------------------------------------------------

/**
 * One aggregated cell. The TypeScript engine never iterates raw records: chunk cost is proportional
 * to periods × dimensions, not to rows, which is what keeps a ten-year ledger inside the budget.
 */
export interface AggregateCell {
  readonly periodId: string;
  readonly source: 'period_balances' | 'ledger' | 'invoices' | 'bank';
  readonly standardCategory: StandardCategory | null;
  readonly accountId: string | null;
  readonly counterpartyId: string | null;
  readonly bankAccountId: string | null;
  readonly balanceKind: 'trial_balance' | 'pnl_report' | 'balance_sheet' | null;
  readonly balanceBasis: 'cumulative' | 'movement' | null;
  readonly invoiceType: string | null;
  /**
   * ADR-028: a DIMENSION, not a filter. Which legs count depends on the family asking — a
   * cash_transfer pair cancels out of cash, a card_repayment does not, and the P&L excludes every
   * kind. Aggregating them together would make the correct answer unrecoverable.
   */
  readonly transferKind?: string | null;
  /** A row that looks like a transfer but was never paired: it stays in the sums, flagged. */
  readonly unpairedTransferCandidate?: boolean;
  /** Sums, as strings. */
  readonly debit: string;
  readonly credit: string;
  readonly amount: string;
  readonly rowCount: number;
  /**
   * Contributing rows whose net-of-tax amount had to fall back to `total_amount` (§3). Only the
   * invoice source can be non-zero: it is how the VAT-inclusive signal reaches the figure.
   */
  readonly fallbackRows: number;
  readonly minDate: string | null;
  readonly maxDate: string | null;
}

export interface PeriodRef {
  readonly id: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly fiscalYear: number;
  readonly fiscalQuarter: number;
  readonly label: string;
  readonly isComplete: boolean;
}

export interface AccountRef {
  readonly id: string;
  readonly code: string | null;
  readonly name: string;
  readonly standardCategory: StandardCategory;
  readonly accountType: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  readonly isSystem: boolean;
  /** ADR-156: secured / unsecured as the business marked a loan account; null or absent = not marked. */
  readonly loanSecurity?: 'secured' | 'unsecured' | null;
}

export interface CounterpartyRef {
  readonly id: string;
  readonly name: string;
  readonly kind: 'customer' | 'supplier' | 'both' | 'unknown';
  readonly mergedIntoId: string | null;
  /**
   * Which expense bucket this supplier's purchase invoices fall into on the invoice basis (§2.1,
   * ADR-027.4). Unset means nobody has said, and the amounts are `uncategorised` — which the P&L
   * reports as such rather than guessing a category.
   */
  readonly defaultExpenseCategory: StandardCategory | null;
}

export interface BankAccountRef {
  readonly id: string;
  readonly name: string;
  readonly accountType: 'current' | 'savings' | 'credit_card' | 'loan' | 'other';
  readonly openingBalance: string | null;
  readonly openingBalanceDate: string | null;
  readonly isActive: boolean;
}

export interface OrganizationSettings {
  readonly baseCurrency: string;
  readonly fiscalYearStartMonth: number;
  readonly timezone: string;
  readonly vatRegistered: boolean;
  /**
   * FU-9: whether `vatRegistered` was actually SET for the organisation, rather than defaulted to
   * false. Absent means known — the contexts written before FU-9 state their footing deliberately.
   */
  readonly vatStatusKnown?: boolean;
  readonly defaultVatRate: string | null;
  /** The categories the bank proxy nets down for VAT (CD-33). */
  readonly taxableCategories: readonly StandardCategory[];
}

// ---------------------------------------------------------------------------------------------
// Coverage and precedence (§2.2, §2.3)
// ---------------------------------------------------------------------------------------------

export type SourceKind = 'period_balances' | 'ledger' | 'invoices' | 'bank';

export interface SourceCoverage {
  readonly covers: boolean;
  /** Set when the source covers the period only partly, or with a caveat. */
  readonly warnings: readonly DataQualityWarning[];
  readonly completeness: number;
  /** For balances: which kind won, and on what basis it is stated. */
  readonly balanceKind?: 'trial_balance' | 'pnl_report' | 'balance_sheet';
  /** N-1: for balances, whether the winning report is complete (attested, IMP-TB-016; a TB balances). */
  readonly reportComplete?: boolean;
  /** The winning report's own record assurance (extraction method); a ceiling for its figures. */
  readonly recordAssurance?: AssuranceLevel | null;
  readonly balanceBasis?: 'cumulative' | 'movement';
}

export interface PeriodCoverage {
  readonly periodId: string;
  readonly bySource: Readonly<Record<SourceKind, SourceCoverage>>;
  /**
   * ADR-122 FU-12: whether committed FULL PURCHASE lists establish P's invoice-basis COSTS
   * (`invoiceCostCoverage`). It never makes the invoices source cover P; on an invoice basis, the cost
   * lines and supplier figures read it, and are NULL `no_source_covers_period` when it does not cover
   * P. Omitted, nothing establishes the costs.
   */
  readonly invoiceCosts?: SourceCoverage;
  /**
   * For `is_complete` (§2.2, ADR-030.1): covered over in-scope cash-like accounts, and 1 when there is
   * nothing to cover (no active cash-like account) — such an organisation's months are not held back.
   * NOT a fact about banking: read `bankEvidenceRatio` for that.
   */
  readonly bankCoverageRatio: number;
  /**
   * H-1 (Step 0E): what is known about the business's banking in P — covered over in-scope cash-like
   * accounts (ADR-124 D-2), or NULL when no cash-like account is in scope (none at all, only closed,
   * or only credit-card / loan accounts). NULL is absence of evidence: neither good nor poor banking.
   */
  readonly bankEvidenceRatio: number | null;
  /**
   * N-1 (Step 0F): P has a balance report that was passed over for the P&L family because it is
   * incomplete and a ledger or invoice source covers P. The chosen basis carries
   * `balance_report_incomplete`.
   */
  readonly balanceReportPassedOver?: boolean;
  readonly latestDataDate: Readonly<Partial<Record<SourceKind, string>>>;
}

/** The chosen source per family, and why (§2.3). */
export interface BasisChoice {
  readonly basis: MetricBasis;
  readonly assurance: AssuranceLevel;
  readonly warnings: readonly DataQualityWarning[];
  readonly proxy: boolean;
  readonly balanceKind?: 'trial_balance' | 'pnl_report' | 'balance_sheet';
  readonly balanceBasis?: 'cumulative' | 'movement';
}

// ---------------------------------------------------------------------------------------------
// The input one period's computation receives
// ---------------------------------------------------------------------------------------------

export interface EngineContext {
  readonly organizationId: string;
  readonly calculationRunId: string;
  readonly aggregatedAt: string;
  /** Today, in the organization's timezone. Used ONLY for aging and runway (§1.1). */
  readonly asOf: string;
  readonly engineVersion: string;
  readonly settings: OrganizationSettings;
  readonly accounts: readonly AccountRef[];
  /**
   * Whether the organisation has EVER posted to a cost-of-sales account (§3.1's "never used").
   *
   * An organisation-level fact, deliberately: asking it of the period being computed made a quiet
   * month say the business does not track cost of sales at all (ADR-063).
   */
  readonly costOfSalesEverUsed: boolean;
  /**
   * Purchase invoices from a supplier whose `default_expense_category` is `cost_of_sales` exist.
   * Counts as "cost of sales ever used" ONLY on the invoice basis: on a ledger or balance basis it
   * is evidence the chosen source is not reading, and the figure says so rather than turning
   * an unstated line into a zero (ADR-104).
   */
  readonly costOfSalesInInvoices: boolean;
  readonly counterparties: readonly CounterpartyRef[];
  readonly bankAccounts: readonly BankAccountRef[];
  readonly periods: readonly PeriodRef[];
}
