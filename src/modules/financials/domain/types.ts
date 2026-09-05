/**
 * Pure financial types (ADR-004). No I/O, no framework — `domain/` stays unit-testable in isolation.
 *
 * Money is a STRING here, never a `number` (ADR-006). A JavaScript number cannot hold 0.1 + 0.2, and
 * a rounding error in a financial figure is not a cosmetic bug. Parse with `@/core/money` at the
 * point of calculation or display, never at the point of transport.
 */

/** The 26 standard categories every calculation is defined over (ADR-004). */
export const STANDARD_CATEGORIES = [
  'revenue', 'other_income', 'cost_of_sales', 'operating_expense', 'payroll', 'marketing',
  'interest_expense', 'tax_expense', 'depreciation', 'other_expense',
  'cash', 'receivables', 'inventory', 'other_current_asset', 'fixed_asset', 'other_asset',
  'payables', 'credit_card', 'loan', 'tax_liability', 'other_current_liability',
  'long_term_liability', 'equity', 'drawings', 'transfer', 'uncategorised',
] as const;
export type StandardCategory = (typeof STANDARD_CATEGORIES)[number];

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

/**
 * The category → type pairing, mirroring `public.standard_category_account_type` in SQL. Both exist
 * because the database enforces it as a CHECK constraint and the UI needs to group without a round
 * trip; a unit test asserts the two agree, since a divergence would let the UI offer a mapping the
 * database will refuse.
 */
export const CATEGORY_ACCOUNT_TYPE: Readonly<Record<StandardCategory, AccountType>> = {
  revenue: 'income',
  other_income: 'income',
  cost_of_sales: 'expense',
  operating_expense: 'expense',
  payroll: 'expense',
  marketing: 'expense',
  interest_expense: 'expense',
  tax_expense: 'expense',
  depreciation: 'expense',
  other_expense: 'expense',
  cash: 'asset',
  receivables: 'asset',
  inventory: 'asset',
  other_current_asset: 'asset',
  fixed_asset: 'asset',
  other_asset: 'asset',
  payables: 'liability',
  credit_card: 'liability',
  loan: 'liability',
  tax_liability: 'liability',
  other_current_liability: 'liability',
  long_term_liability: 'liability',
  equity: 'equity',
  drawings: 'equity',
  // Holding categories, not statement lines. Assets so that a transfer or an unmapped movement can
  // never silently move a profit figure; the engine excludes both from P&L explicitly.
  transfer: 'asset',
  uncategorised: 'asset',
} as const;

/** Categories the P&L is built from, in statement order. */
export const PNL_CATEGORIES: readonly StandardCategory[] = [
  'revenue', 'other_income', 'cost_of_sales', 'operating_expense', 'payroll', 'marketing',
  'interest_expense', 'tax_expense', 'depreciation', 'other_expense',
];

export type RecordStatus =
  | 'pending' | 'needs_review' | 'accepted' | 'duplicate' | 'rejected' | 'incomplete';

/**
 * How much a figure can be relied upon (FINANCIAL_ENGINE.md §5). It travels with every record and
 * propagates to the weakest input of any metric derived from it, so a number never looks firmer than
 * the data underneath it.
 */
export type AssuranceLevel = 'verified' | 'calculated' | 'estimated' | 'inferred';

export type EntryDirection = 'debit' | 'credit';
export type BalanceKind = 'trial_balance' | 'pnl_report' | 'balance_sheet';
/** ADR-027.2: whether a balance figure is year-to-date or just this period's movement. */
export type BalanceBasis = 'cumulative' | 'movement';
export type InvoiceType = 'sales' | 'purchase' | 'sales_credit_note' | 'purchase_credit_note';
export type InvoiceStatus = 'open' | 'partially_paid' | 'paid' | 'void';
export type CounterpartyKind = 'customer' | 'supplier' | 'both' | 'unknown';
export type MappingConfidence = 'confirmed' | 'suggested' | 'unmapped';
export type AccountSource = 'seeded' | 'imported' | 'user';

export interface FiscalPeriod {
  readonly id: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly fiscalYear: number;
  readonly fiscalQuarter: number;
  readonly label: string;
  /** ADR-030.1: set by the calculation run, never by an import. */
  readonly isComplete: boolean;
  readonly isLocked: boolean;
}

export interface Account {
  readonly id: string;
  readonly code: string | null;
  readonly name: string;
  readonly accountType: AccountType;
  readonly standardCategory: StandardCategory;
  readonly isSystem: boolean;
  readonly isActive: boolean;
  readonly source: AccountSource;
  readonly mappingConfidence: MappingConfidence;
}

export interface Counterparty {
  readonly id: string;
  readonly name: string;
  readonly kind: CounterpartyKind;
  readonly defaultExpenseCategory: StandardCategory | null;
  readonly isActive: boolean;
  readonly mergedIntoId: string | null;
}

export interface LedgerEntry {
  readonly id: string;
  readonly entryDate: string;
  readonly periodId: string;
  readonly accountId: string;
  readonly direction: EntryDirection;
  /** Unsigned; the sign lives in `direction`. */
  readonly amount: string;
  readonly currency: string;
  readonly description: string | null;
  readonly reference: string | null;
  readonly counterpartyId: string | null;
  readonly journalRef: string | null;
  readonly recordStatus: RecordStatus;
  readonly assuranceLevel: AssuranceLevel;
  readonly isOpeningBalance: boolean;
  readonly supersededBy: string | null;
}

export interface PeriodBalance {
  readonly id: string;
  readonly periodStart: string;
  readonly periodId: string;
  readonly accountId: string;
  readonly openingBalance: string | null;
  /** Natural sign: debit − credit. */
  readonly closingBalance: string;
  readonly currency: string;
  readonly balanceKind: BalanceKind;
  readonly balanceBasis: BalanceBasis;
  readonly recordStatus: RecordStatus;
  readonly assuranceLevel: AssuranceLevel;
  readonly supersededBy: string | null;
}

export interface Invoice {
  readonly id: string;
  readonly invoiceType: InvoiceType;
  readonly counterpartyId: string;
  readonly invoiceNumber: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly periodId: string;
  readonly totalAmount: string;
  readonly amountPaid: string;
  readonly balanceDue: string;
  readonly currency: string;
  readonly status: InvoiceStatus;
  readonly paidDate: string | null;
  readonly recordStatus: RecordStatus;
  readonly assuranceLevel: AssuranceLevel;
  readonly supersededBy: string | null;
}

/** The four tables whose lifecycle `record_status_events` logs. */
export type FinancialRecordTable =
  'ledger_entries' | 'bank_transactions' | 'invoices' | 'period_balances';
