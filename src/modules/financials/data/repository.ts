import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import type {
  Account, Counterparty, FiscalPeriod, Invoice, LedgerEntry, PeriodBalance,
} from '../domain/types';

/**
 * Reads for the financial tables.
 *
 * Every query here runs on the CALLER's client, so Row Level Security decides what comes back
 * (ADR-013, ADR-026). The `organization_id` filter in each query is therefore a second fence and an
 * index hint, not the security boundary: if it were ever omitted, RLS would still return only the
 * caller's rows. The service client is never used on a request path.
 *
 * Every list is bounded. An unbounded select on a tenant table is a denial-of-service waiting for
 * the first customer with three years of general ledger.
 */

interface Page {
  readonly limit: number;
  readonly offset: number;
}

function unwrap<T>(data: T[] | null, error: unknown, requestId?: string): T[] {
  if (error) throw toMotionError(error, requestId);
  return data ?? [];
}

export async function listPeriods(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<FiscalPeriod[]> {
  const { data, error } = await db
    .from('fiscal_periods')
    .select('id, period_start, period_end, fiscal_year, fiscal_quarter, label, is_complete, is_locked')
    .eq('organization_id', orgId)
    .order('period_start', { ascending: false });

  return unwrap(data, error, requestId).map((r) => ({
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
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<Account[]> {
  const { data, error } = await db
    .from('accounts')
    .select('id, code, name, account_type, standard_category, is_system, is_active, source, mapping_confidence')
    .eq('organization_id', orgId)
    .order('standard_category')
    .order('name');

  return unwrap(data, error, requestId).map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    accountType: r.account_type,
    standardCategory: r.standard_category,
    isSystem: r.is_system,
    isActive: r.is_active,
    source: r.source,
    mappingConfidence: r.mapping_confidence,
  }));
}

export async function listCounterparties(
  db: SupabaseClient, orgId: string, page: Page, requestId?: string,
): Promise<Counterparty[]> {
  const { data, error } = await db
    .from('counterparties')
    .select('id, name, kind, default_expense_category, is_active, merged_into_id')
    .eq('organization_id', orgId)
    // A merged counterparty is history, not a choice: it must not appear in a picker.
    .is('merged_into_id', null)
    .order('name')
    .range(page.offset, page.offset + page.limit - 1);

  return unwrap(data, error, requestId).map((r) => ({
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
  db: SupabaseClient, orgId: string, periodId: string, page: Page, requestId?: string,
): Promise<LedgerEntry[]> {
  const { data, error } = await db
    .from('ledger_entries')
    .select(`id, entry_date, period_id, account_id, direction, amount, currency, description,
             reference, counterparty_id, journal_ref, record_status, assurance_level,
             is_opening_balance, superseded_by`)
    .eq('organization_id', orgId)
    .eq('period_id', periodId)
    .eq('record_status', 'accepted')
    .is('superseded_by', null)
    .order('entry_date')
    .order('id')
    .range(page.offset, page.offset + page.limit - 1);

  return unwrap(data, error, requestId).map((r) => ({
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
  db: SupabaseClient, orgId: string, periodId: string, requestId?: string,
): Promise<PeriodBalance[]> {
  const { data, error } = await db
    .from('period_balances')
    .select(`id, period_start, period_id, account_id, opening_balance, closing_balance, currency,
             balance_kind, balance_basis, record_status, assurance_level, superseded_by`)
    .eq('organization_id', orgId)
    .eq('period_id', periodId)
    .eq('record_status', 'accepted')
    .is('superseded_by', null)
    .order('account_id');

  return unwrap(data, error, requestId).map((r) => ({
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
  db: SupabaseClient,
  orgId: string,
  filter: { readonly invoiceType?: Invoice['invoiceType']; readonly openOnly?: boolean },
  page: Page,
  requestId?: string,
): Promise<Invoice[]> {
  let query = db
    .from('invoices')
    .select(`id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id,
             total_amount, amount_paid, balance_due, currency, status, paid_date,
             record_status, assurance_level, superseded_by`)
    .eq('organization_id', orgId)
    .eq('record_status', 'accepted')
    .is('superseded_by', null);

  if (filter.invoiceType) query = query.eq('invoice_type', filter.invoiceType);
  if (filter.openOnly) query = query.in('status', ['open', 'partially_paid']);

  const { data, error } = await query
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('id')
    .range(page.offset, page.offset + page.limit - 1);

  return unwrap(data, error, requestId).map((r) => ({
    id: r.id,
    invoiceType: r.invoice_type,
    counterpartyId: r.counterparty_id,
    invoiceNumber: r.invoice_number,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    periodId: r.period_id,
    totalAmount: r.total_amount,
    amountPaid: r.amount_paid,
    balanceDue: r.balance_due,
    currency: r.currency,
    status: r.status,
    paidDate: r.paid_date,
    recordStatus: r.record_status,
    assuranceLevel: r.assurance_level,
    supersededBy: r.superseded_by,
  }));
}
