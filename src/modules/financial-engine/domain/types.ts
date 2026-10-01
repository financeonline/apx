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
  'statement_balance_mismatch', 'unreconciled_statement', 'basis_differs', 'sign_change',
  'new_in_period', 'partial_working_capital', 'no_due_dates', 'payment_date_unknown',
  'fewer_than_5', 'high_unattributed_share', 'negative_revenue', 'unpaired_transfer_candidate',
  'partial_month', 'no_cost_of_sales', 'cash_positive', 'no_cost_allocation',
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
  /** Cost of sales exists in a source the chosen P&L basis is not reading (ADR-104). */
  'cost_of_sales_in_other_source',
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

export type EvidenceQuery =
  | { readonly kind: 'leaf'; readonly descriptor: LeafDescriptor }
  /** A derived metric points at the snapshots it was computed from, so a reader can descend. */
  | { readonly kind: 'derived'; readonly components: ReadonlyArray<{ name: string; snapshot_id: string | null }> };

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
  /** Active cash-like accounts with a covering statement, over all active cash-like accounts. */
  readonly bankCoverageRatio: number;
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
