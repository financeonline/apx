import 'server-only';
import { Decimal } from '@/core/money';
import type { Db } from '@/db/types';
import { readOrganizationRow, readRows } from '@/db/app/financials-reads';
import type {
  Account, Counterparty, FiscalPeriod, Invoice, LedgerEntry, PeriodBalance,
} from '../domain/types';

/**
 * Reads for the financial tables.
 *
 * Every read here is made as the CALLER (`readRows`): for a person, `src/db/rls.ts` applies each
 * table's policy, as Row Level Security did on their client (ADR-013, ADR-026); for a job, only the
 * organisation the job is scoped to is readable. Each read names one organisation's collection, so
 * a query cannot run across tenants by accident.
 *
 * Every list is bounded. An unbounded select on a tenant table is a denial-of-service waiting for
 * the first customer with three years of general ledger.
 *
 * Orders that PostgreSQL took from a collation or an enum (names, the standard category) are applied
 * here, in TypeScript, over the organisation's rows: Firestore orders strings by code unit, which
 * would put "Zeta" before "acme".
 */

/** `ORDER BY name` under the database's en_US collation: case and accents second. */
export const byName = new Intl.Collator('en-US', { sensitivity: 'variant' }).compare;

const STANDARD_CATEGORY_ORDER = [
  'revenue', 'other_income', 'cost_of_sales', 'operating_expense', 'payroll', 'marketing',
  'interest_expense', 'tax_expense', 'depreciation', 'other_expense', 'cash', 'receivables',
  'inventory', 'other_current_asset', 'fixed_asset', 'other_asset', 'payables', 'credit_card',
  'loan', 'tax_liability', 'other_current_liability', 'long_term_liability', 'equity', 'drawings',
  'transfer', 'uncategorised',
];
/** `ORDER BY standard_category` sorted by the enum's declared order, not its text. */
export const byCategory = (a: string, b: string): number => STANDARD_CATEGORY_ORDER.indexOf(a) - STANDARD_CATEGORY_ORDER.indexOf(b);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Page {
  readonly limit: number;
  readonly offset: number;
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function listPeriods(
  db: Db, orgId: string, requestId?: string,
): Promise<FiscalPeriod[]> {
  void requestId;
  const rows = await readRows<Row>(db, orgId, 'fiscal_periods', (q) => q.orderBy('period_start', 'desc'));
  return rows.map((r) => ({
    id: r.id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    fiscalYear: r.fiscal_year,
    fiscalQuarter: r.fiscal_quarter,
    label: r.label,
    isComplete: r.is_complete,
    isLocked: r.is_locked,
  }));
}

export async function listAccounts(
  db: Db, orgId: string, requestId?: string,
): Promise<Account[]> {
  void requestId;
  const rows = await readRows<Row>(db, orgId, 'accounts');
  rows.sort((a, b) => byCategory(a.standard_category, b.standard_category) || byName(a.name, b.name));
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    accountType: r.account_type,
    standardCategory: r.standard_category,
    isSystem: r.is_system,
    isActive: r.is_active,
    source: r.source,
    mappingConfidence: r.mapping_confidence,
    loanSecurity: r.loan_security ?? null,
  }));
}

export async function listCounterparties(
  db: Db, orgId: string, page: Page, requestId?: string,
): Promise<Counterparty[]> {
  void requestId;
  // A merged counterparty is history, not a choice: it must not appear in a picker.
  const rows = await readRows<Row>(db, orgId, 'counterparties', (q) => q.where('merged_into_id', '==', null));
  rows.sort((a, b) => byName(a.name, b.name) || byText(a.id, b.id));
  return rows.slice(page.offset, page.offset + page.limit).map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    defaultExpenseCategory: r.default_expense_category,
    isActive: r.is_active,
    mergedIntoId: r.merged_into_id,
  }));
}

/**
 * Accepted, non-superseded ledger entries for a period. That pair of filters is the definition of
 * "current" everywhere in the system (ADR-047.1); a caller that wants history asks the evidence
 * resolver with an `as_of`, which reconstructs it from `record_status_events`.
 */
export async function listLedgerEntries(
  db: Db, orgId: string, periodId: string, page: Page, requestId?: string,
): Promise<LedgerEntry[]> {
  void requestId;
  // Composite index: ledger_entries (period_id, record_status, superseded_by, entry_date, id).
  const rows = await readRows<Row>(db, orgId, 'ledger_entries', (q) => q
    .where('period_id', '==', periodId)
    .where('record_status', '==', 'accepted')
    .where('superseded_by', '==', null)
    .orderBy('entry_date')
    .orderBy('id')
    .offset(page.offset)
    .limit(page.limit));
  return rows.map((r) => ({
    id: r.id,
    entryDate: r.entry_date,
    periodId: r.period_id,
    accountId: r.account_id,
    direction: r.direction,
    amount: r.amount,
    currency: r.currency,
    description: r.description,
    reference: r.reference,
    counterpartyId: r.counterparty_id,
    journalRef: r.journal_ref,
    recordStatus: r.record_status,
    assuranceLevel: r.assurance_level,
    isOpeningBalance: r.is_opening_balance,
    supersededBy: r.superseded_by,
  }));
}

export async function listPeriodBalances(
  db: Db, orgId: string, periodId: string, requestId?: string,
): Promise<PeriodBalance[]> {
  void requestId;
  const rows = await readRows<Row>(db, orgId, 'period_balances', (q) => q
    .where('period_id', '==', periodId)
    .where('record_status', '==', 'accepted')
    .where('superseded_by', '==', null));
  rows.sort((a, b) => byText(a.account_id, b.account_id));
  return rows.map((r) => ({
    id: r.id,
    periodStart: r.period_start,
    periodId: r.period_id,
    accountId: r.account_id,
    openingBalance: r.opening_balance,
    closingBalance: r.closing_balance,
    currency: r.currency,
    balanceKind: r.balance_kind,
    balanceBasis: r.balance_basis,
    recordStatus: r.record_status,
    assuranceLevel: r.assurance_level,
    supersededBy: r.superseded_by,
  }));
}

export async function listInvoices(
  db: Db,
  orgId: string,
  filter: { readonly invoiceType?: Invoice['invoiceType']; readonly openOnly?: boolean },
  page: Page,
  requestId?: string,
): Promise<Invoice[]> {
  void requestId;
  const rows = await readRows<Row>(db, orgId, 'invoices', (q) => {
    let query = q.where('record_status', '==', 'accepted').where('superseded_by', '==', null);
    if (filter.invoiceType) query = query.where('invoice_type', '==', filter.invoiceType);
    if (filter.openOnly) query = query.where('status', 'in', ['open', 'partially_paid']);
    return query;
  });
  // `ORDER BY due_date ASC NULLS LAST, id`: Firestore sorts null first, so the order is applied here.
  rows.sort((a, b) => {
    if (a.due_date !== b.due_date) {
      if (a.due_date === null || a.due_date === undefined) return 1;
      if (b.due_date === null || b.due_date === undefined) return -1;
      return byText(a.due_date, b.due_date);
    }
    return byText(a.id, b.id);
  });
  return rows.slice(page.offset, page.offset + page.limit).map((r) => ({
    id: r.id,
    invoiceType: r.invoice_type,
    counterpartyId: r.counterparty_id,
    invoiceNumber: r.invoice_number,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    periodId: r.period_id,
    totalAmount: r.total_amount,
    amountPaid: r.amount_paid,
    // `balance_due` was a generated column (total − paid); a row stores it, or it is derived.
    balanceDue: r.balance_due ?? new Decimal(String(r.total_amount)).minus(String(r.amount_paid ?? 0)).toFixed(2),
    currency: r.currency,
    status: r.status,
    paidDate: r.paid_date,
    recordStatus: r.record_status,
    assuranceLevel: r.assurance_level,
    supersededBy: r.superseded_by,
  }));
}

/**
 * The organisation's base currency, for a form's label — never assumed (core/money). Null when the
 * caller cannot reach the organisation.
 */
export async function loadBaseCurrency(db: Db, orgId: string): Promise<string | null> {
  const org = await readOrganizationRow(db, orgId);
  return org ? String(org.base_currency ?? 'GBP').trim() : null;
}

export interface HeldCounterparty {
  readonly id: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly kind: string;
}

/**
 * The counterparties whose name is held awaiting an identity decision (ADR-136):
 * `normalized_name LIKE '% [held %]'`, not merged away, by name — filtered and ordered here over the
 * organisation's unmerged counterparties.
 */
export async function listHeldCounterparties(db: Db, orgId: string): Promise<HeldCounterparty[]> {
  const rows = await readRows<Row>(db, orgId, 'counterparties', (q) => q.where('merged_into_id', '==', null));
  return rows
    .filter((r) => /^.+ \[held .*\]$/s.test(String(r.normalized_name)))
    .sort((a, b) => byName(a.name, b.name))
    .map((r) => ({ id: r.id, name: r.name, normalizedName: r.normalized_name, kind: r.kind }));
}
