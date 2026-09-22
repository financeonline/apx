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

/**
 * The filters the Banking pages page through (Phase 13). `uncategorisedAccountId` is the
 * organisation's `uncategorised` holding account, so "not yet categorised" means "no category OR
 * parked in the holding account" — the same test `isUncategorised` applies to a loaded row.
 */
export interface BankTransactionFilter {
  readonly bankAccountId?: string;
  readonly periodId?: string;
  readonly direction?: 'inflow' | 'outflow';
  readonly transfersOnly?: boolean;
  readonly uncategorisedAccountId?: string;
  readonly recurringGroupId?: string;
}

const TXN_COLUMNS = `id, bank_account_id, transaction_date, period_id, amount, currency,
             description_normalized, counterparty_id, category_account_id, category_source,
             is_transfer, transfer_kind, transfer_pair_id, recurring_group_id,
             record_status, assurance_level, superseded_by`;

/**
 * PostgREST filter clauses for `BankTransactionFilter`, as `(column, operator, value)` triples so the
 * list and the count apply exactly the same predicate. `or` is the one clause that is not a triple.
 */
function clausesFor(filter: BankTransactionFilter): {
  readonly eq: ReadonlyArray<readonly [string, unknown]>;
  readonly gt: ReadonlyArray<readonly [string, unknown]>;
  readonly lt: ReadonlyArray<readonly [string, unknown]>;
  readonly or: readonly string[];
} {
  const eq: Array<readonly [string, unknown]> = [];
  const gt: Array<readonly [string, unknown]> = [];
  const lt: Array<readonly [string, unknown]> = [];
  const or: string[] = [];
  if (filter.bankAccountId) eq.push(['bank_account_id', filter.bankAccountId]);
  if (filter.periodId) eq.push(['period_id', filter.periodId]);
  if (filter.direction === 'inflow') gt.push(['amount', 0]);
  if (filter.direction === 'outflow') lt.push(['amount', 0]);
  if (filter.transfersOnly) eq.push(['is_transfer', true]);
  if (filter.recurringGroupId) eq.push(['recurring_group_id', filter.recurringGroupId]);
  if (filter.uncategorisedAccountId) {
    or.push(`category_account_id.is.null,category_account_id.eq.${filter.uncategorisedAccountId}`);
  }
  return { eq, gt, lt, or };
}

export async function listBankTransactions(
  db: SupabaseClient,
  orgId: string,
  filter: BankTransactionFilter,
  page: Page,
  requestId?: string,
): Promise<BankTransaction[]> {
  const clauses = clausesFor(filter);
  let query = db
    .from('bank_transactions')
    .select(TXN_COLUMNS)
    .eq('organization_id', orgId)
    .eq('record_status', 'accepted')
    .is('superseded_by', null);
  for (const [column, value] of clauses.eq) query = query.eq(column, value);
  for (const [column, value] of clauses.gt) query = query.gt(column, value);
  for (const [column, value] of clauses.lt) query = query.lt(column, value);
  for (const clause of clauses.or) query = query.or(clause);

  const { data, error } = await query
    .order('transaction_date', { ascending: false })
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

/** How many rows match, for paging. Same filters, same visibility rules, no rows loaded. */
export async function countBankTransactions(
  db: SupabaseClient, orgId: string, filter: BankTransactionFilter, requestId?: string,
): Promise<number> {
  const clauses = clausesFor(filter);
  let query = db
    .from('bank_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('record_status', 'accepted')
    .is('superseded_by', null);
  for (const [column, value] of clauses.eq) query = query.eq(column, value);
  for (const [column, value] of clauses.gt) query = query.gt(column, value);
  for (const [column, value] of clauses.lt) query = query.lt(column, value);
  for (const clause of clauses.or) query = query.or(clause);
  const { count, error } = await query;
  if (error) throw toMotionError(error, requestId);
  return count ?? 0;
}

/**
 * One row, current or not. The Banking transaction page shows a superseded or rejected row with
 * its standing rather than pretending it never existed (EVIDENCE_MODEL.md §5.2); the caller reads
 * `recordStatus`/`supersededBy` and says so. `null` when the id is not this organisation's — the
 * uniform not-found (§8.4).
 */
export async function loadBankTransaction(
  db: SupabaseClient, orgId: string, transactionId: string, requestId?: string,
): Promise<(BankTransaction & { readonly balanceAfter: string | null; readonly reference: string | null; readonly postedDate: string | null }) | null> {
  const { data, error } = await db
    .from('bank_transactions')
    .select(`${TXN_COLUMNS}, balance_after, reference, posted_date`)
    .eq('organization_id', orgId)
    .eq('id', transactionId)
    .maybeSingle();
  if (error) throw toMotionError(error, requestId);
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    id: r.id as string,
    bankAccountId: r.bank_account_id as string,
    transactionDate: r.transaction_date as string,
    periodId: r.period_id as string,
    amount: String(r.amount),
    currency: r.currency as string,
    descriptionNormalized: (r.description_normalized as string | null) ?? null,
    counterpartyId: (r.counterparty_id as string | null) ?? null,
    categoryAccountId: (r.category_account_id as string | null) ?? null,
    categorySource: r.category_source as BankTransaction['categorySource'],
    isTransfer: r.is_transfer as boolean,
    transferKind: r.transfer_kind as BankTransaction['transferKind'],
    transferPairId: (r.transfer_pair_id as string | null) ?? null,
    recurringGroupId: (r.recurring_group_id as string | null) ?? null,
    recordStatus: r.record_status as string,
    assuranceLevel: r.assurance_level as string,
    supersededBy: (r.superseded_by as string | null) ?? null,
    balanceAfter: r.balance_after === null || r.balance_after === undefined ? null : String(r.balance_after),
    reference: (r.reference as string | null) ?? null,
    postedDate: (r.posted_date as string | null) ?? null,
  };
}

export interface RecurringGroupRow {
  readonly id: string;
  readonly bankAccountId: string | null;
  readonly counterpartyKey: string;
  readonly direction: 'inflow' | 'outflow';
  readonly cadence: string;
  readonly expectedAmount: string;
  readonly amountToleranceRatio: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly occurrenceCount: number;
  readonly nextExpected: string | null;
  readonly status: 'active' | 'changed' | 'stopped';
}

/** The detected recurring flows, as the banking pass last wrote them (Phase 13). */
export async function listRecurringGroups(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<RecurringGroupRow[]> {
  const { data, error } = await db
    .from('recurring_payment_groups')
    .select(`id, bank_account_id, counterparty_key, direction, cadence, expected_amount,
             amount_tolerance_ratio, first_seen, last_seen, occurrence_count, next_expected, status`)
    .eq('organization_id', orgId)
    .order('expected_amount', { ascending: false })
    .order('id');
  return unwrap(data, error, requestId).map((r) => ({
    id: r.id,
    bankAccountId: r.bank_account_id,
    counterpartyKey: r.counterparty_key,
    direction: r.direction,
    cadence: r.cadence,
    expectedAmount: String(r.expected_amount),
    amountToleranceRatio: String(r.amount_tolerance_ratio),
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    occurrenceCount: Number(r.occurrence_count),
    nextExpected: r.next_expected,
    status: r.status,
  }));
}

/** The latest member of each group: its masked description and amount, to name the group by. */
export async function loadLatestGroupMembers(
  db: SupabaseClient, orgId: string, groupIds: readonly string[], requestId?: string,
): Promise<Map<string, { description: string | null; amount: string; date: string; id: string }>> {
  const out = new Map<string, { description: string | null; amount: string; date: string; id: string }>();
  if (groupIds.length === 0) return out;
  const { data, error } = await db
    .from('bank_transactions')
    .select('id, recurring_group_id, description_normalized, amount, transaction_date')
    .eq('organization_id', orgId)
    .eq('record_status', 'accepted')
    .is('superseded_by', null)
    .in('recurring_group_id', [...groupIds])
    .order('transaction_date', { ascending: false })
    .order('id', { ascending: false });
  for (const r of unwrap(data, error, requestId)) {
    const key = r.recurring_group_id as string;
    if (!out.has(key)) {
      out.set(key, { id: r.id, description: r.description_normalized, amount: String(r.amount), date: r.transaction_date });
    }
  }
  return out;
}
