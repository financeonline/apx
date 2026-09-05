import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import type {
  AccountRef, AggregateCell, BankAccountRef, CounterpartyRef, OrganizationSettings, PeriodRef,
} from '../domain/types';
import type { CoverageBatch } from '../domain/coverage';

/**
 * The engine's reads (FINANCIAL_ENGINE.md §2.4 step 4).
 *
 * Everything runs inside a job under `withOrgScope`, so the client here is the service role and the
 * organization filter on every query is the tenant boundary rather than a hint. That is why each
 * function takes `orgId` explicitly and passes it to `.eq('organization_id', …)` without exception —
 * the lint rule `motion/no-unscoped-service-query` fails the build if one is forgotten.
 *
 * The heavy lifting is a single SQL aggregation. The engine never iterates raw records: chunk cost
 * is proportional to periods × dimensions, not rows.
 */

function unwrap<T>(data: T[] | null, error: unknown): T[] {
  if (error) throw toMotionError(error);
  return data ?? [];
}

/** L0. One row per period × source × category × account × counterparty × bank account. */
export async function loadAggregates(
  scoped: SupabaseClient,
  orgId: string,
  from: string,
  to: string,
  aggregatedAt: string,
): Promise<AggregateCell[]> {
  const { data, error } = await scoped.rpc('aggregate_periods', {
    p_org: orgId, p_from: from, p_to: to, p_aggregated_at: aggregatedAt,
  });

  return unwrap(data as Record<string, unknown>[] | null, error).map((r) => ({
    periodId: r.period_id as string,
    source: r.source as AggregateCell['source'],
    standardCategory: r.standard_category as AggregateCell['standardCategory'],
    accountId: r.account_id as string | null,
    counterpartyId: r.counterparty_id as string | null,
    bankAccountId: r.bank_account_id as string | null,
    balanceKind: r.balance_kind as AggregateCell['balanceKind'],
    balanceBasis: r.balance_basis as AggregateCell['balanceBasis'],
    invoiceType: r.invoice_type as string | null,
    transferKind: (r.transfer_kind as string | null) ?? null,
    unpairedTransferCandidate: r.unpaired_transfer === true,
    debit: String(r.debit ?? '0'),
    credit: String(r.credit ?? '0'),
    amount: String(r.amount ?? '0'),
    rowCount: Number(r.row_count ?? 0),
    minDate: r.min_date as string | null,
    maxDate: r.max_date as string | null,
  }));
}

export interface TransferLeg {
  readonly periodId: string;
  readonly bankAccountId: string;
  readonly transferKind: string;
  readonly inflow: string;
  readonly outflow: string;
}

export async function loadTransferLegs(
  scoped: SupabaseClient, orgId: string, from: string, to: string, aggregatedAt: string,
): Promise<TransferLeg[]> {
  const { data, error } = await scoped.rpc('aggregate_transfer_legs', {
    p_org: orgId, p_from: from, p_to: to, p_aggregated_at: aggregatedAt,
  });

  return unwrap(data as Record<string, unknown>[] | null, error).map((r) => ({
    periodId: r.period_id as string,
    bankAccountId: r.bank_account_id as string,
    transferKind: r.transfer_kind as string,
    inflow: String(r.inflow ?? '0'),
    outflow: String(r.outflow ?? '0'),
  }));
}

/** The declared export ranges coverage is computed from (§2.2). */
export async function loadCoverageBatches(
  scoped: SupabaseClient, orgId: string, from: string, to: string,
): Promise<CoverageBatch[]> {
  const { data, error } = await scoped.rpc('batch_coverage', {
    p_org: orgId, p_from: from, p_to: to,
  });

  return unwrap(data as Record<string, unknown>[] | null, error).map((r) => ({
    id: r.batch_id as string,
    targetTable: r.target_table as CoverageBatch['targetTable'],
    balanceKind: r.balance_kind as CoverageBatch['balanceKind'],
    balanceBasis: null,
    bankAccountId: r.bank_account_id as string | null,
    invoiceListKind: r.invoice_list_kind as CoverageBatch['invoiceListKind'],
    periodStart: r.period_start as string,
    periodEnd: r.period_end as string,
    committedAt: r.committed_at as string,
  }));
}

export async function loadPeriods(
  scoped: SupabaseClient, orgId: string,
): Promise<PeriodRef[]> {
  const { data, error } = await scoped
    .from('fiscal_periods')
    .select('id, period_start, period_end, fiscal_year, fiscal_quarter, label, is_complete')
    .eq('organization_id', orgId)
    .order('period_start');

  return unwrap(data, error).map((r) => ({
    id: r.id as string,
    periodStart: r.period_start as string,
    periodEnd: r.period_end as string,
    fiscalYear: Number(r.fiscal_year),
    fiscalQuarter: Number(r.fiscal_quarter),
    label: r.label as string,
    isComplete: Boolean(r.is_complete),
  }));
}

export async function loadAccounts(
  scoped: SupabaseClient, orgId: string,
): Promise<AccountRef[]> {
  const { data, error } = await scoped
    .from('accounts')
    .select('id, code, name, standard_category, account_type, is_system')
    .eq('organization_id', orgId);

  return unwrap(data, error).map((r) => ({
    id: r.id as string,
    code: r.code as string | null,
    name: r.name as string,
    standardCategory: r.standard_category as AccountRef['standardCategory'],
    accountType: r.account_type as AccountRef['accountType'],
    isSystem: Boolean(r.is_system),
  }));
}

export async function loadCounterparties(
  scoped: SupabaseClient, orgId: string,
): Promise<CounterpartyRef[]> {
  const { data, error } = await scoped
    .from('counterparties')
    .select('id, name, kind, merged_into_id')
    .eq('organization_id', orgId);

  return unwrap(data, error).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as CounterpartyRef['kind'],
    mergedIntoId: r.merged_into_id as string | null,
  }));
}

export async function loadBankAccounts(
  scoped: SupabaseClient, orgId: string,
): Promise<BankAccountRef[]> {
  const { data, error } = await scoped
    .from('bank_accounts')
    .select('id, name, account_type, opening_balance, opening_balance_date, is_active')
    .eq('organization_id', orgId);

  return unwrap(data, error).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    accountType: r.account_type as BankAccountRef['accountType'],
    openingBalance: r.opening_balance === null ? null : String(r.opening_balance),
    openingBalanceDate: r.opening_balance_date as string | null,
    isActive: Boolean(r.is_active),
  }));
}

export async function loadSettings(
  scoped: SupabaseClient, orgId: string,
): Promise<OrganizationSettings> {
  const { data, error } = await scoped
    .from('organizations')
    .select('base_currency, fiscal_year_start_month, timezone, settings')
    .eq('id', orgId)
    .maybeSingle();

  if (error) throw toMotionError(error);
  const settings = (data?.settings ?? {}) as Record<string, unknown>;

  return {
    baseCurrency: (data?.base_currency as string) ?? 'GBP',
    fiscalYearStartMonth: Number(data?.fiscal_year_start_month ?? 1),
    timezone: (data?.timezone as string) ?? 'Europe/London',
    vatRegistered: settings.vat_registered === true,
    defaultVatRate: settings.default_vat_rate === undefined || settings.default_vat_rate === null
      ? null : String(settings.default_vat_rate),
    // CD-33: the categories the bank proxy nets down. The platform default is applied by the
    // caller when the organization has no override.
    taxableCategories: Array.isArray(settings.taxable_categories)
      ? (settings.taxable_categories as OrganizationSettings['taxableCategories'])
      : ['revenue', 'cost_of_sales', 'operating_expense', 'marketing'],
  };
}

/** The metadata the fingerprint is computed from, before any write (§2.4 step 2). */
export interface FingerprintSources {
  readonly maxRecordEventAt: string | null;
  readonly rowCounts: Record<string, number>;
  readonly accountCategories: Record<string, string>;
  readonly counterpartyMerges: Record<string, string>;
  readonly categoryHistoryHeads: Record<string, string>;
}

export async function loadFingerprintSources(
  scoped: SupabaseClient, orgId: string,
): Promise<FingerprintSources> {
  const [events, accounts, counterparties, history] = await Promise.all([
    scoped.from('record_status_events').select('at').eq('organization_id', orgId)
      .order('at', { ascending: false }).limit(1),
    scoped.from('accounts').select('id, standard_category').eq('organization_id', orgId),
    scoped.from('counterparties').select('id, merged_into_id').eq('organization_id', orgId)
      .not('merged_into_id', 'is', null),
    scoped.from('category_history').select('id, bank_transaction_id').eq('organization_id', orgId)
      .is('valid_to', null),
  ]);

  const rowCounts: Record<string, number> = {};
  for (const table of ['ledger_entries', 'period_balances', 'invoices', 'bank_transactions'] as const) {
    const { count } = await scoped
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('record_status', 'accepted')
      .is('superseded_by', null);
    rowCounts[table] = count ?? 0;
  }

  return {
    maxRecordEventAt: (events.data?.[0]?.at as string | undefined) ?? null,
    rowCounts,
    accountCategories: Object.fromEntries(
      (accounts.data ?? []).map((a) => [a.id as string, a.standard_category as string]),
    ),
    counterpartyMerges: Object.fromEntries(
      (counterparties.data ?? []).map((c) => [c.id as string, c.merged_into_id as string]),
    ),
    categoryHistoryHeads: Object.fromEntries(
      (history.data ?? []).map((h) => [h.bank_transaction_id as string, h.id as string]),
    ),
  };
}
