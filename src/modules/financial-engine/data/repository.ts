import 'server-only';
import { asDate, globalRow, orgCollection, orgRow } from '@/db/schema';
import type { Db } from '@/db/types';
import { aggregatePeriods, aggregateTransferLegs, bankDailyMovements, batchCoverage } from '@/core/db';
import type {
  AccountRef, AggregateCell, AssuranceLevel, BankAccountRef, CounterpartyRef, OrganizationSettings, PeriodRef,
} from '../domain/types';
import type { CoverageBatch } from '../domain/coverage';
import { statementRecordAssurance, type DailyMovement } from '../domain/cash-history';
import type { AgingInvoice } from '../domain/receivables';
import type { OpeningJournalLine, PreJournalLine } from '../domain/receivables-input';

/**
 * The engine's reads (FINANCIAL_ENGINE.md §2.4 step 4).
 *
 * Everything runs inside a job under `withOrgScope`, so the handle here is the server's and the
 * organisation named on every read is the tenant boundary rather than a hint. That is why each
 * function takes `orgId` explicitly and reads `organizations/{orgId}/…` (FIRESTORE_DATA_MODEL.md §3)
 * without exception: there is no query here that could reach another organisation's rows.
 *
 * The heavy lifting is the aggregation (`api_server.aggregate_periods`, computed over the rows by
 * `src/db/app/engine-aggregate.ts`). The domain never iterates raw records: chunk cost is
 * proportional to periods × dimensions, not rows.
 *
 * The SQL filters `record_status = 'accepted' and superseded_by is null` and `created_at <= instant`
 * are applied exactly; where Firestore would need a composite index for a range on a second field,
 * the equality filters run in the query and the range is applied to the rows here.
 */

/** Firestore `in` takes at most 30 values. */
const IN_LIMIT = 30;

type DocumentData = FirebaseFirestore.DocumentData;
type Query = FirebaseFirestore.Query;

const rowsOf = async (q: Query): Promise<DocumentData[]> => (await q.get()).docs.map((d) => d.data());

/** `record_status = 'accepted' and superseded_by is null` — the rows the engine may see at all. */
const current = (q: Query): Query => q.where('record_status', '==', 'accepted').where('superseded_by', '==', null);

/** `created_at <= p_aggregated_at`, compared as instants (the strings may differ in format). */
function visibleAt(row: DocumentData, aggregatedAt: string): boolean {
  const created = asDate(row.created_at);
  const at = asDate(aggregatedAt);
  return created !== null && at !== null && created.getTime() <= at.getTime();
}

function chunked<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += IN_LIMIT) out.push(values.slice(i, i + IN_LIMIT));
  return out;
}

const byId = (a: DocumentData, b: DocumentData): number => String(a.id).localeCompare(String(b.id));

/** L0. One row per period × source × category × account × counterparty × bank account. */
export async function loadAggregates(
  scoped: Db,
  orgId: string,
  from: string,
  to: string,
  aggregatedAt: string,
): Promise<AggregateCell[]> {
  /*
   * Through `api_server`, not through an unqualified `rpc()`.
   *
   * `app.aggregate_periods` is not on PostgREST's exposed schema list, so the unqualified call
   * resolved against `public` and returned PGRST202 for every calculation ever attempted
   * (ADR-057.2). The wrapper is service-role only, which is what the calculation worker holds.
   */
  const rows = await aggregatePeriods(orgId, from, to, aggregatedAt);
  void scoped;

  return rows.map((r: Record<string, unknown>) => ({
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
    fallbackRows: Number(r.fallback_rows ?? 0),
    minDate: r.min_date as string | null,
    maxDate: r.max_date as string | null,
  }));
}

/** Every bank account's rows summed per day, to `to` (ADR-124 D-1: the per-account cash history). */
export async function loadBankDailyMovements(
  orgId: string, to: string, aggregatedAt: string,
): Promise<DailyMovement[]> {
  const rows = await bankDailyMovements(orgId, to, aggregatedAt);
  return rows.map((r) => ({
    bankAccountId: r.bank_account_id as string,
    date: r.transaction_date as string,
    amount: String(r.amount ?? '0'),
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
  scoped: Db, orgId: string, from: string, to: string, aggregatedAt: string,
): Promise<TransferLeg[]> {
  const rows = await aggregateTransferLegs(orgId, from, to, aggregatedAt);
  void scoped;

  return rows.map((r: Record<string, unknown>) => ({
    periodId: r.period_id as string,
    bankAccountId: r.bank_account_id as string,
    transferKind: r.transfer_kind as string,
    inflow: String(r.inflow ?? '0'),
    outflow: String(r.outflow ?? '0'),
  }));
}

/** The declared export ranges coverage is computed from (§2.2). */
export async function loadCoverageBatches(
  scoped: Db, orgId: string, from: string, to: string,
): Promise<CoverageBatch[]> {
  const rows = await batchCoverage(orgId, from, to);
  void scoped;

  return rows.map((r: Record<string, unknown>) => ({
    id: r.batch_id as string,
    targetTable: r.target_table as CoverageBatch['targetTable'],
    balanceKind: r.balance_kind as CoverageBatch['balanceKind'],
    // H-2: the basis the reviewer confirmed (IMP-TB-012). It was hard-coded NULL, so every report was
    // read as a movement report and a cumulative trial balance's year-to-date as the month.
    balanceBasis: (r.balance_basis as CoverageBatch['balanceBasis'] | undefined) ?? null,
    fiscalYearStartMonthAtCommit: r.fiscal_year_start_month_at_commit === null || r.fiscal_year_start_month_at_commit === undefined
      ? null : Number(r.fiscal_year_start_month_at_commit),
    // Step 0E: the months this balance batch has rows in (a batch states only those, or its whole range
    // when it has none). NULL for other targets.
    rowMonths: Array.isArray(r.row_months) ? (r.row_months as unknown[]).map(String) : null,
    // N-1 (Step 0F): what is known, per month, about whether the report lists every account — an
    // owner's attestation, else the import's answer (IMP-TB-016); a month absent is unconfirmed.
    completenessByMonth: r.completeness_by_month && typeof r.completeness_by_month === 'object'
      ? r.completeness_by_month as Record<string, 'complete' | 'partial'> : null,
    recordAssurance: (r.record_assurance as AssuranceLevel | null | undefined) ?? null,
    // R-2: whether a full invoice list holds the invoices still unpaid at its start (NULL: unanswered).
    openingConfirmed: typeof r.opening_confirmed === 'boolean' ? r.opening_confirmed : null,
    bankAccountId: r.bank_account_id as string | null,
    invoiceListKind: r.invoice_list_kind as CoverageBatch['invoiceListKind'],
    importType: (r.import_type as string | null) ?? null,
    periodStart: r.period_start as string,
    periodEnd: r.period_end as string,
    committedAt: r.committed_at as string,
  }));
}

export async function loadPeriods(
  scoped: Db, orgId: string,
): Promise<PeriodRef[]> {
  const rows = await rowsOf(orgCollection(scoped.fs, orgId, 'fiscal_periods').orderBy('period_start'));

  return rows.map((r) => ({
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
  scoped: Db, orgId: string,
): Promise<AccountRef[]> {
  // Every row (ADR-120 hardening: an account past PostgREST's 1,000th row was invisible to every
  // family — its ledger cells folded into nothing and a receivables account went unrecognised).
  const rows = (await rowsOf(orgCollection(scoped.fs, orgId, 'accounts'))).sort(byId);

  return rows.map((r) => ({
    id: r.id as string,
    code: r.code as string | null,
    name: r.name as string,
    standardCategory: r.standard_category as AccountRef['standardCategory'],
    accountType: r.account_type as AccountRef['accountType'],
    isSystem: Boolean(r.is_system),
    loanSecurity: (r.loan_security ?? null) as AccountRef['loanSecurity'],
  }));
}

export async function loadCounterparties(
  scoped: Db, orgId: string,
): Promise<CounterpartyRef[]> {
  // Every row (ADR-120 hardening): a purchase invoice's expense category comes from its supplier, so
  // a supplier past PostgREST's 1,000th row sent its purchases to `uncategorised`.
  const rows = (await rowsOf(orgCollection(scoped.fs, orgId, 'counterparties'))).sort(byId);

  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as CounterpartyRef['kind'],
    mergedIntoId: r.merged_into_id as string | null,
    defaultExpenseCategory: (r.default_expense_category as CounterpartyRef['defaultExpenseCategory']) ?? null,
  }));
}

export async function loadBankAccounts(
  scoped: Db, orgId: string,
): Promise<BankAccountRef[]> {
  const rows = (await rowsOf(orgCollection(scoped.fs, orgId, 'bank_accounts'))).sort(byId);

  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    accountType: r.account_type as BankAccountRef['accountType'],
    openingBalance: r.opening_balance === null || r.opening_balance === undefined ? null : String(r.opening_balance),
    openingBalanceDate: (r.opening_balance_date as string | null | undefined) ?? null,
    isActive: Boolean(r.is_active),
  }));
}

export async function loadSettings(
  scoped: Db, orgId: string,
): Promise<OrganizationSettings> {
  const snap = await globalRow(scoped.fs, 'organizations', orgId).get();
  const data = snap.exists ? snap.data()! : null;
  const settings = (data?.settings ?? {}) as Record<string, unknown>;

  return {
    baseCurrency: (data?.base_currency as string) ?? 'GBP',
    fiscalYearStartMonth: Number(data?.fiscal_year_start_month ?? 1),
    timezone: (data?.timezone as string) ?? 'Europe/London',
    vatRegistered: settings.vat_registered === true,
    // FU-9: nothing in the product sets `vat_registered` yet, so "not set" must stay distinguishable
    // from "not registered" — only the second makes ledger costs VAT-inclusive.
    vatStatusKnown: typeof settings.vat_registered === 'boolean',
    defaultVatRate: settings.default_vat_rate === undefined || settings.default_vat_rate === null
      ? null : String(settings.default_vat_rate),
    // CD-33: the categories the bank proxy nets down. The platform default is applied by the
    // caller when the organization has no override.
    taxableCategories: Array.isArray(settings.taxable_categories)
      ? (settings.taxable_categories as OrganizationSettings['taxableCategories'])
      : ['revenue', 'cost_of_sales', 'operating_expense', 'marketing'],
  };
}

/**
 * The instant the DATABASE stamped on this run, which is the instant it aggregates as of.
 *
 * `app.aggregate_periods` selects rows with `created_at <= p_aggregated_at`, and `created_at` is
 * written by Postgres. Pinning that cutoff from the worker's own `new Date()` therefore compares two
 * clocks, and whenever the database's is the further ahead — it is, by tens of milliseconds, on any
 * host running Postgres in a VM — rows committed BEFORE the run began fall the wrong side of the
 * cutoff and the run computes without them. Nothing raises: the figures are simply a period short of
 * some of its entries, and a metric whose shape depends on whether an account carried rows (§3.1's
 * `no_cost_of_sales_accounts`) silently changes shape from one run to the next.
 *
 * `calculation_runs.started_at` is `now()` from the same clock as `created_at`, so a row committed
 * before the run was started is on the inside of the cutoff by construction rather than by luck.
 * `alerts.evaluate` already takes its instant from this row (§8.3); the run loop now does too.
 */
export async function loadRunStartedAt(
  scoped: Db, orgId: string, runId: string,
): Promise<string> {
  const snap = await orgRow(scoped.fs, orgId, 'calculation_runs', runId).get();
  const startedAt = snap.exists ? ((snap.get('started_at') as string | null | undefined) ?? null) : null;
  if (startedAt === null) {
    // Falling back to the process clock is what this function exists to stop, so it refuses instead:
    // a run that cannot say which instant it read at cannot write a reproducible descriptor (§2.4
    // step 4, ADR-046.2), and the caller already turns a throw into a failed run with its pointers
    // restored.
    throw new Error(`calculation run ${runId} has no started_at to aggregate as of`);
  }
  return startedAt;
}

/** The metadata the fingerprint is computed from, before any write (§2.4 step 2). */
export interface FingerprintSources {
  readonly maxRecordEventAt: string | null;
  readonly rowCounts: Record<string, number>;
  readonly accountCategories: Record<string, string>;
  readonly counterpartyMerges: Record<string, string>;
  readonly categoryHistoryHeads: Record<string, string>;
  /** Step 0F: `import|month` → the current completeness attestation id. */
  readonly completenessHeads?: Record<string, string>;
}

/**
 * Whether this organisation has EVER posted to a cost-of-sales account (§3.1, CD-05).
 *
 * §3.1 words the test as "system account only, never used", and *never* is the operative word. The
 * engine used to answer it from the period being computed, which turns a quiet month into a
 * statement about the business: a shop that bought no stock in August was told it does not track
 * cost of sales at all, so `cost_of_sales` went NULL, `gross_profit` silently became revenue with a
 * `no_cost_of_sales` warning, and `gross_margin` showed "n/a" for a month it could have shown
 * (ADR-063). CD-05's exception is a property of the CHART, not of the month.
 *
 * Asked once per run, over the two sources a P&L is ever computed from.
 */
export async function loadCostOfSalesEverUsed(
  scoped: Db, orgId: string,
): Promise<boolean> {
  const rows = (await rowsOf(orgCollection(scoped.fs, orgId, 'accounts')
    .where('standard_category', '==', 'cost_of_sales'))) as Array<{ id: string; is_system: boolean }>;
  // An account the customer created is the answer on its own: they made it deliberately.
  if (rows.some((account) => !account.is_system)) return true;
  if (rows.length === 0) return false;

  const ids = rows.map((account) => account.id);
  for (const table of ['ledger_entries', 'period_balances'] as const) {
    for (const chunk of chunked(ids)) {
      const hit = await current(orgCollection(scoped.fs, orgId, table)).where('account_id', 'in', chunk).limit(1).get();
      if (!hit.empty) return true;
    }
  }

  return false;
}

/**
 * Do purchase invoices from a supplier whose `default_expense_category` is `cost_of_sales` exist?
 *
 * The invoice source carries figures without an account (§2.1), so the account-bearing check above
 * cannot see them. Kept SEPARATE from `loadCostOfSalesEverUsed` on purpose (ADR-104): it counts as
 * "ever used" only when the invoices are the P&L basis. On a ledger basis it is evidence the chosen
 * source is not reading — and the P&L then says `cost_of_sales_in_other_source` rather than
 * turning a line the ledger never stated into a zero and a 100% margin.
 */
export async function loadCostOfSalesInInvoices(
  scoped: Db, orgId: string,
): Promise<boolean> {
  const suppliers = await rowsOf(orgCollection(scoped.fs, orgId, 'counterparties')
    .where('default_expense_category', '==', 'cost_of_sales'));
  const supplierIds = suppliers.map((c) => c.id as string);
  if (supplierIds.length === 0) return false;

  // One `in` per query: the supplier list is the query's, the type and void filters are applied here.
  for (const chunk of chunked(supplierIds)) {
    const purchases = await rowsOf(current(orgCollection(scoped.fs, orgId, 'invoices')).where('counterparty_id', 'in', chunk));
    if (purchases.some((i) => i.status !== 'void' && (i.invoice_type === 'purchase' || i.invoice_type === 'purchase_credit_note'))) {
      return true;
    }
  }
  return false;
}

/**
 * The organisation's earliest period that carries any accepted record.
 *
 * The first-period gate (§8.1) silences variance-based rules there: the earliest month has nothing
 * to compare against, and a rule that fires on "up from nothing" would greet every new customer with
 * a spike alert on their first import.
 *
 * Four indexed `limit 1` reads once per run, plus `period_balances`, which carries no date of its
 * own and is matched on its period. Ordering happens against `allPeriods` rather than on uuids,
 * because a period id says nothing about when the period was.
 */
export async function loadFirstPeriodWithData(
  scoped: Db, orgId: string, allPeriods: readonly PeriodRef[],
): Promise<string | null> {
  const dated = [
    ['ledger_entries', 'entry_date'],
    ['bank_transactions', 'transaction_date'],
    ['invoices', 'issue_date'],
  ] as const;

  const periodIds = new Set<string>();

  for (const [table, dateColumn] of dated) {
    const first = await current(orgCollection(scoped.fs, orgId, table)).orderBy(dateColumn, 'asc').limit(1).get();
    const periodId = first.docs[0]?.get('period_id') as string | undefined;
    if (periodId !== undefined) periodIds.add(periodId);
  }

  const balances = await current(orgCollection(scoped.fs, orgId, 'period_balances')).select('period_id').get();
  for (const row of balances.docs) periodIds.add(String(row.get('period_id')));

  for (const period of allPeriods) {
    if (periodIds.has(period.id)) return period.id;
  }
  return null;
}

export async function loadFingerprintSources(
  scoped: Db, orgId: string,
): Promise<FingerprintSources> {
  const fs = scoped.fs;
  const [events, accounts, counterparties, history, attestations] = await Promise.all([
    rowsOf(orgCollection(fs, orgId, 'record_status_events').orderBy('at', 'desc').limit(1)),
    rowsOf(orgCollection(fs, orgId, 'accounts').select('id', 'standard_category')),
    rowsOf(orgCollection(fs, orgId, 'counterparties').where('merged_into_id', '!=', null).select('id', 'merged_into_id')),
    rowsOf(orgCollection(fs, orgId, 'category_history').where('valid_to', '==', null).select('id', 'bank_transaction_id')),
    // Step 0F: an owner's completeness attestation changes figures without moving any record.
    rowsOf(orgCollection(fs, orgId, 'report_completeness_attestations').select('id', 'import_batch_id', 'period_start', 'attested_at')),
  ]);
  // `order by attested_at, id`: the last in time order is the current one.
  attestations.sort((a, b) => (asDate(a.attested_at)?.getTime() ?? 0) - (asDate(b.attested_at)?.getTime() ?? 0)
    || String(a.id).localeCompare(String(b.id)));

  const rowCounts: Record<string, number> = {};
  for (const table of ['ledger_entries', 'period_balances', 'invoices', 'bank_transactions'] as const) {
    const counted = await current(orgCollection(fs, orgId, table)).count().get();
    rowCounts[table] = counted.data().count;
  }

  return {
    maxRecordEventAt: (events[0]?.at as string | undefined) ?? null,
    rowCounts,
    accountCategories: Object.fromEntries(accounts.map((a) => [a.id as string, a.standard_category as string])),
    counterpartyMerges: Object.fromEntries(counterparties.map((c) => [c.id as string, c.merged_into_id as string])),
    categoryHistoryHeads: Object.fromEntries(history.map((h) => [h.bank_transaction_id as string, h.id as string])),
    // The current attestation per (import, month): the last in time order.
    completenessHeads: Object.fromEntries(
      attestations.map((a) => [`${a.import_batch_id as string}|${a.period_start as string}`, a.id as string]),
    ),
  };
}

/**
 * One stored figure of a comparison period, as `metric_current` points at it — what the variance
 * pass reads for a period this run did not recompute (FINANCIAL_ENGINE.md §3.2; ADR-080).
 */
export interface StoredObservation {
  readonly periodId: string;
  readonly metricKey: string;
  readonly dimensionType: string;
  readonly dimensionId: string | null;
  readonly dimensionKey: string | null;
  readonly snapshotId: string;
  readonly value: string | null;
  readonly basis: string;
  readonly assurance: string;
  readonly dataQuality: { completeness?: number; warnings?: string[]; missing?: string[] };
}

export async function loadCurrentObservations(
  scoped: Db, orgId: string, periodIds: readonly string[], metricKeys: readonly string[],
): Promise<StoredObservation[]> {
  if (periodIds.length === 0 || metricKeys.length === 0) return [];
  // Every row (ADR-120: the comparison set — every variance base × dimension × up to thirteen
  // periods — passed PostgREST's silent 1,000-row cap). The pointer is read by period, the metric
  // keys are applied here (one `in` per query), and the snapshot is a second read (the old
  // `metric_snapshots!inner` embed: a pointer whose snapshot is missing is dropped).
  const fs = scoped.fs;
  const keys = new Set(metricKeys);
  const pointers = (await Promise.all(chunked([...new Set(periodIds)]).map((chunk) =>
    rowsOf(orgCollection(fs, orgId, 'metric_current').where('period_id', 'in', chunk))))).flat()
    .filter((r) => keys.has(String(r.metric_key)));
  const nullsFirst = (a: unknown, b: unknown): number => {
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    return String(a) < String(b) ? -1 : 1;
  };
  pointers.sort((a, b) => nullsFirst(a.period_id, b.period_id) || nullsFirst(a.metric_key, b.metric_key)
    || nullsFirst(a.dimension_type, b.dimension_type) || nullsFirst(a.dimension_id, b.dimension_id)
    || nullsFirst(a.dimension_key, b.dimension_key));
  const snapshotIds = [...new Set(pointers.map((r) => String(r.snapshot_id)))];
  const snapshots = new Map<string, DocumentData>();
  for (let i = 0; i < snapshotIds.length; i += 300) {
    const refs = snapshotIds.slice(i, i + 300).map((id) => orgRow(fs, orgId, 'metric_snapshots', id));
    for (const snap of await fs.getAll(...refs)) if (snap.exists) snapshots.set(snap.id, snap.data()!);
  }

  return pointers.flatMap((r) => {
    const s = snapshots.get(String(r.snapshot_id)) as { value: unknown; basis: string; assurance_level: string; data_quality: StoredObservation['dataQuality'] } | undefined;
    if (!s) return [];
    return [{
      periodId: r.period_id as string,
      metricKey: r.metric_key as string,
      dimensionType: r.dimension_type as string,
      dimensionId: (r.dimension_id as string | null) ?? null,
      dimensionKey: (r.dimension_key as string | null) ?? null,
      snapshotId: r.snapshot_id as string,
      value: s.value === null || s.value === undefined ? null : String(s.value),
      basis: s.basis,
      assurance: s.assurance_level,
      dataQuality: s.data_quality ?? {},
    }];
  });
}

// ---------------------------------------------------------------------------------------------
// Receivables, payables and the version gate (ADR-120)
// ---------------------------------------------------------------------------------------------

/**
 * The invoice rows receivables and payables are aged from (§3.4).
 *
 * The CURRENT row of every accepted, non-superseded invoice (ADR-047.10) visible at the chunk's
 * aggregation instant — the same three conditions `app.aggregate_periods` applies, so the aging and
 * the P&L read the same set of documents. Void invoices are returned and excluded by the domain,
 * which owns that rule (ADR-107). `issue_date ≤ issuedBy` because nothing issued later can be owed.
 *
 * This is the one engine read that is proportional to rows rather than to periods × dimensions: the
 * Phase 4 domain function ages invoices, and a SQL re-implementation of its rule would be a second
 * copy of it. Recorded in ADR-120 as a known scaling finding.
 */
export async function loadAgingInvoices(
  scoped: Db, orgId: string, issuedBy: string, aggregatedAt: string,
): Promise<AgingInvoice[]> {
  const rows = (await rowsOf(current(orgCollection(scoped.fs, orgId, 'invoices'))))
    .filter((r) => visibleAt(r, aggregatedAt) && String(r.issue_date) <= issuedBy)
    .sort(byId);
  return rows.map((r) => ({
      id: r.id as string,
      invoiceType: r.invoice_type as AgingInvoice['invoiceType'],
      counterpartyId: (r.counterparty_id as string | null) ?? null,
      issueDate: r.issue_date as string,
      dueDate: (r.due_date as string | null) ?? null,
      totalAmount: String(r.total_amount),
      amountPaid: String(r.amount_paid ?? '0'),
      balanceDue: String(r.balance_due),
      paidDate: (r.paid_date as string | null) ?? null,
      status: r.status as AgingInvoice['status'],
    }));
}

/**
 * The opening-balance journal (IMP-GL-011, ADR-027.3 item 3), or null when the organisation has
 * none. Its existence is what turns a ledger's running total into a balance: without it a GL exported
 * from March knows nothing of what was owed in February.
 */
export async function loadOpeningJournal(
  scoped: Db, orgId: string, aggregatedAt: string,
): Promise<OpeningJournalLine[] | null> {
  const rows = (await rowsOf(current(orgCollection(scoped.fs, orgId, 'ledger_entries')).where('is_opening_balance', '==', true)))
    .filter((r) => visibleAt(r, aggregatedAt))
    .sort(byId);
  const lines = rows.map((r) => ({
    accountId: r.account_id as string,
    periodId: r.period_id as string,
    entryDate: r.entry_date as string,
    debit: r.direction === 'debit' ? String(r.amount) : '0',
    credit: r.direction === 'credit' ? String(r.amount) : '0',
  }));
  return lines.length === 0 ? null : lines;
}

/**
 * Every current ledger line of `periodId` dated before `journalDate`, opening lines included
 * (ADR-124 D-4): the part of a month that an opening journal dated inside it already contains.
 */
export async function loadLinesBeforeJournal(
  scoped: Db, orgId: string, periodId: string, journalDate: string, aggregatedAt: string,
): Promise<PreJournalLine[]> {
  const rows = (await rowsOf(current(orgCollection(scoped.fs, orgId, 'ledger_entries')).where('period_id', '==', periodId)))
    .filter((r) => String(r.entry_date) < journalDate && visibleAt(r, aggregatedAt))
    .sort(byId);
  return rows.map((r) => ({
    journalDate,
    accountId: r.account_id as string,
    debit: r.direction === 'debit' ? String(r.amount) : '0',
    credit: r.direction === 'credit' ? String(r.amount) : '0',
  }));
}

/**
 * The engine version of the organisation's latest succeeded run, or null when it has none.
 *
 * A run on a different engine version must recompute the whole history (FINANCIAL_ENGINE.md §6): the
 * carries (cash, the days windows) start from the stored figures of the period before the range, and
 * figures an older engine wrote are not a starting point this one can trust (ADR-120).
 */
/**
 * The Health config the organisation's latest score was worked out under (ADR-147), or NULL when it
 * has no score. A different config than the deployed one means its history is re-scored.
 */
export async function loadLatestHealthConfigVersion(
  scoped: Db, orgId: string,
): Promise<string | null> {
  const rows = await rowsOf(orgCollection(scoped.fs, orgId, 'health_scores').orderBy('created_at', 'desc').limit(1));
  return (rows[0]?.config_version as string | undefined) ?? null;
}

/**
 * The organisation's latest succeeded run: `order by finished_at desc nulls last`. Firestore sorts
 * null first ascending, so descending puts a null `finished_at` last, as PostgreSQL did.
 */
async function latestSucceededRun(scoped: Db, orgId: string): Promise<DocumentData | null> {
  const rows = await rowsOf(orgCollection(scoped.fs, orgId, 'calculation_runs')
    .where('status', '==', 'succeeded').orderBy('finished_at', 'desc').limit(1));
  return rows[0] ?? null;
}

export async function loadLatestEngineVersion(
  scoped: Db, orgId: string,
): Promise<string | null> {
  return ((await latestSucceededRun(scoped, orgId))?.engine_version as string | undefined) ?? null;
}

/**
 * FU-6: the as-of date of the latest succeeded run, so a run after a month end can recompute the
 * month that was current when it last ran. Null for an organisation never run.
 */
export async function loadLatestRunAsOf(
  scoped: Db, orgId: string,
): Promise<string | null> {
  return ((await latestSucceededRun(scoped, orgId))?.as_of as string | null | undefined) ?? null;
}

/** A committed bank statement: its declared range and the balances printed on it (IMP-BAL). */
export interface StatementBatch {
  readonly batchId: string;
  readonly bankAccountId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly committedAt: string;
  /** Printed opening / closing balance — deterministic or reviewer-typed only, never an AI reading. */
  readonly openingBalance: string | null;
  readonly closingBalance: string | null;
  /** The rows did not add up to the printed balances at import (IMP-BAL-006/007). */
  readonly unreconciled: boolean;
  /** What commit stamped on the statement's rows (ADR-130). */
  readonly assurance: AssuranceLevel;
}

/**
 * Every committed bank statement of the organisation (ADR-120 / ADR-123): CD-06's first opening
 * source, the closing cross-check and the "does not reconcile" flag §3.3 names — all three are facts
 * about the statement batch. The balance columns hold only parsed or reviewer-typed values: "an AI
 * reading never reaches these columns" (migration 20260905000032).
 */
export async function loadStatements(
  scoped: Db, orgId: string,
): Promise<StatementBatch[]> {
  const rows = (await rowsOf(orgCollection(scoped.fs, orgId, 'import_batches')
    .where('status', '==', 'committed').where('target_table', '==', 'bank_transactions')))
    .filter((r) => r.bank_account_id !== null && r.bank_account_id !== undefined)
    .sort(byId);
  return rows.map((r) => {
    const issues = Array.isArray(r.batch_issues) ? (r.batch_issues as Array<{ code?: unknown }>) : [];
    return {
      batchId: r.id as string,
      bankAccountId: r.bank_account_id as string,
      periodStart: r.period_start as string,
      periodEnd: r.period_end as string,
      committedAt: String(r.committed_at),
      openingBalance: r.statement_opening_balance == null ? null : String(r.statement_opening_balance),
      closingBalance: r.statement_closing_balance == null ? null : String(r.statement_closing_balance),
      unreconciled: issues.some((issue) => issue.code === 'IMP-BAL-006' || issue.code === 'IMP-BAL-007'),
      // ADR-130: what commit stamped on this statement's rows, from the same two facts.
      assurance: statementRecordAssurance(
        r.extraction_method === null || r.extraction_method === undefined ? null : String(r.extraction_method),
        issues.some((issue) => issue.code === 'IMP-BAL-006' || issue.code === 'IMP-BAL-007'),
      ),
    };
  });
}
