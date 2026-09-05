import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import type { BankAccount, BankTransaction } from '../domain/types';

/**
 * Banking reads, on the caller's client so RLS applies (ADR-013).
 *
 * Note what is NOT selected: `description_raw` and `counterparty_name_raw`. The privilege is revoked
 * from `authenticated` entirely (ADR-044.2; R2-A-04), so naming them here would fail for every user
 * including an owner. Import review reaches them through `readRawDescriptions` below, which goes via
 * the definer view and its own permission check.
 */

interface Page { readonly limit: number; readonly offset: number }

function unwrap<T>(data: T[] | null, error: unknown, requestId?: string): T[] {
  if (error) throw toMotionError(error, requestId);
  return data ?? [];
}

export async function listBankAccounts(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<BankAccount[]> {
  const { data, error } = await db
    .from('bank_accounts')
    .select(`id, name, bank_name, account_number_masked, sort_code_masked, currency, account_type,
             ledger_account_id, opening_balance, opening_balance_date, is_active`)
    .eq('organization_id', orgId)
    .order('name');

  return unwrap(data, error, requestId).map((r) => ({
    id: r.id,
    name: r.name,
    bankName: r.bank_name,
    accountNumberMasked: r.account_number_masked,
    sortCodeMasked: r.sort_code_masked,
    currency: r.currency,
    accountType: r.account_type,
    ledgerAccountId: r.ledger_account_id,
    openingBalance: r.opening_balance,
    openingBalanceDate: r.opening_balance_date,
    isActive: r.is_active,
  }));
}

export async function listBankTransactions(
  db: SupabaseClient,
  orgId: string,
  filter: { readonly bankAccountId?: string; readonly periodId?: string },
  page: Page,
  requestId?: string,
): Promise<BankTransaction[]> {
  let query = db
    .from('bank_transactions')
    .select(`id, bank_account_id, transaction_date, period_id, amount, currency,
             description_normalized, counterparty_id, category_account_id, category_source,
             is_transfer, transfer_kind, transfer_pair_id, recurring_group_id,
             record_status, assurance_level, superseded_by`)
    .eq('organization_id', orgId)
    .eq('record_status', 'accepted')
    .is('superseded_by', null);

  if (filter.bankAccountId) query = query.eq('bank_account_id', filter.bankAccountId);
  if (filter.periodId) query = query.eq('period_id', filter.periodId);

  const { data, error } = await query
    .order('transaction_date')
    .order('id')
    .range(page.offset, page.offset + page.limit - 1);

  return unwrap(data, error, requestId).map((r) => ({
    id: r.id,
    bankAccountId: r.bank_account_id,
    transactionDate: r.transaction_date,
    periodId: r.period_id,
    amount: r.amount,
    currency: r.currency,
    descriptionNormalized: r.description_normalized,
    counterpartyId: r.counterparty_id,
    categoryAccountId: r.category_account_id,
    categorySource: r.category_source,
    isTransfer: r.is_transfer,
    transferKind: r.transfer_kind,
    transferPairId: r.transfer_pair_id,
    recurringGroupId: r.recurring_group_id,
    recordStatus: r.record_status,
    assuranceLevel: r.assurance_level,
    supersededBy: r.superseded_by,
  }));
}

/**
 * Raw statement text, for import review and the evidence trace only.
 *
 * Reads the `bank_transactions_raw` definer view rather than the table, because the underlying
 * columns are not selectable by `authenticated` at all. The view re-checks `imports.review` in its
 * own body, so a caller without it gets zero rows rather than an error — which is the correct
 * answer to "show me the raw text" from somebody not entitled to see it.
 */
export async function readRawDescriptions(
  db: SupabaseClient, orgId: string, transactionIds: readonly string[], requestId?: string,
): Promise<Array<{ id: string; descriptionRaw: string | null; counterpartyNameRaw: string | null }>> {
  if (transactionIds.length === 0) return [];
  const { data, error } = await db
    .from('bank_transactions_raw')
    .select('id, description_raw, counterparty_name_raw')
    .eq('organization_id', orgId)
    .in('id', [...transactionIds]);

  return unwrap(data, error, requestId).map((r) => ({
    id: r.id,
    descriptionRaw: r.description_raw,
    counterpartyNameRaw: r.counterparty_name_raw,
  }));
}
