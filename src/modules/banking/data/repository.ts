import 'server-only';
import { Decimal } from '@/core/money';
import type { Db } from '@/db/types';
import { readRows, readRowById } from '@/db/app/financials-reads';
import { hasPermission } from '@/db/app/access';
import { orgCollection, orgRow } from '@/db/schema';
import type { BankAccount, BankTransaction } from '../domain/types';

/**
 * Banking reads, made as the caller (`readRows`: the table's policy for a person, the job's own
 * organisation for a job — ADR-013).
 *
 * Note what is never returned: `description_raw` and `counterparty_name_raw`. On PostgreSQL the
 * privilege was revoked from `authenticated` entirely (ADR-044.2; R2-A-04); the documents carry the
 * fields, so these readers map only the masked ones. Import review reaches the raw text through
 * `readRawDescriptions` below, which applies the `bank_transactions_raw` view's own checks.
 *
 * Filters on an amount's sign and orders by date are applied here over the matching rows: amounts
 * are decimal strings (FIRESTORE_DATA_MODEL.md §3), which a Firestore range cannot compare as numbers.
 */

interface Page { readonly limit: number; readonly offset: number }

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byName = new Intl.Collator('en-US', { sensitivity: 'variant' }).compare;
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export async function listBankAccounts(
  db: Db, orgId: string, requestId?: string,
): Promise<BankAccount[]> {
  void requestId;
  const rows = await readRows<Row>(db, orgId, 'bank_accounts');
  rows.sort((x, y) => byName(x.name, y.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    bankName: r.bank_name,
    accountNumberMasked: r.account_number_masked ?? null,
    sortCodeMasked: r.sort_code_masked ?? null,
    currency: r.currency,
    accountType: r.account_type,
    ledgerAccountId: r.ledger_account_id ?? null,
    openingBalance: r.opening_balance ?? null,
    openingBalanceDate: r.opening_balance_date ?? null,
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

function toTransaction(r: Row): BankTransaction {
  return {
    id: r.id,
    bankAccountId: r.bank_account_id,
    transactionDate: r.transaction_date,
    periodId: r.period_id,
    amount: String(r.amount),
    currency: r.currency,
    descriptionNormalized: r.description_normalized ?? null,
    counterpartyId: r.counterparty_id ?? null,
    categoryAccountId: r.category_account_id ?? null,
    categorySource: r.category_source,
    isTransfer: r.is_transfer === true,
    transferKind: r.transfer_kind,
    transferPairId: r.transfer_pair_id ?? null,
    recurringGroupId: r.recurring_group_id ?? null,
    recordStatus: r.record_status,
    assuranceLevel: r.assurance_level,
    supersededBy: r.superseded_by ?? null,
  };
}

/**
 * The accepted, current rows matching `filter`, newest first (`transaction_date desc, id`). The
 * equality filters run in Firestore; the sign of the amount and "uncategorised" are applied here,
 * so the list and the count apply exactly the same predicate.
 */
async function matching(db: Db, orgId: string, filter: BankTransactionFilter): Promise<Row[]> {
  const rows = await readRows<Row>(db, orgId, 'bank_transactions', (q) => {
    let query = q.where('record_status', '==', 'accepted').where('superseded_by', '==', null);
    if (filter.bankAccountId) query = query.where('bank_account_id', '==', filter.bankAccountId);
    if (filter.periodId) query = query.where('period_id', '==', filter.periodId);
    if (filter.transfersOnly) query = query.where('is_transfer', '==', true);
    if (filter.recurringGroupId) query = query.where('recurring_group_id', '==', filter.recurringGroupId);
    return query;
  });
  const kept = rows.filter((r) => {
    const amount = new Decimal(String(r.amount));
    if (filter.direction === 'inflow' && !amount.greaterThan(0)) return false;
    if (filter.direction === 'outflow' && !amount.lessThan(0)) return false;
    if (filter.uncategorisedAccountId && !(r.category_account_id === null || r.category_account_id === undefined
      || r.category_account_id === filter.uncategorisedAccountId)) return false;
    return true;
  });
  return kept.sort((x, y) => byText(y.transaction_date, x.transaction_date) || byText(x.id, y.id));
}

export async function listBankTransactions(
  db: Db,
  orgId: string,
  filter: BankTransactionFilter,
  page: Page,
  requestId?: string,
): Promise<BankTransaction[]> {
  void requestId;
  return (await matching(db, orgId, filter)).slice(page.offset, page.offset + page.limit).map(toTransaction);
}

const IN_REVIEW = new Set(['created', 'parsing', 'mapping', 'validating', 'awaiting_review', 'failed']);

/**
 * Raw statement text, for import review and the evidence trace only.
 *
 * The `bank_transactions_raw` view's rule, applied here: the caller holds `imports.review` and
 * `banking.view` or `financials.view`, and the row belongs to a batch still in review — or is the
 * row an import row under review was found to duplicate. Anyone else gets zero rows rather than an
 * error, which is the correct answer to "show me the raw text" from somebody not entitled to see it.
 */
export async function readRawDescriptions(
  db: Db, orgId: string, transactionIds: readonly string[], requestId?: string,
): Promise<Array<{ id: string; descriptionRaw: string | null; counterpartyNameRaw: string | null }>> {
  void requestId;
  if (transactionIds.length === 0 || db.actor.kind !== 'user') return [];
  const permitted = await hasPermission(db, orgId, 'imports.review')
    && (await hasPermission(db, orgId, 'banking.view') || await hasPermission(db, orgId, 'financials.view'));
  if (!permitted) return [];
  const out: Array<{ id: string; descriptionRaw: string | null; counterpartyNameRaw: string | null }> = [];
  const batchInReview = new Map<string, boolean>();
  const inReview = async (batchId: unknown): Promise<boolean> => {
    if (typeof batchId !== 'string') return false;
    if (!batchInReview.has(batchId)) {
      const b = await orgRow(db.fs, orgId, 'import_batches', batchId).get();
      batchInReview.set(batchId, b.exists && IN_REVIEW.has(String(b.get('status'))));
    }
    return batchInReview.get(batchId)!;
  };
  for (const id of [...new Set(transactionIds)]) {
    const snap = await orgRow(db.fs, orgId, 'bank_transactions', id).get();
    if (!snap.exists) continue;
    const r = snap.data()!;
    let visible = await inReview(r.import_batch_id);
    if (!visible) {
      const dupes = await orgCollection(db.fs, orgId, 'import_rows')
        .where('duplicate_of_table', '==', 'bank_transactions').where('duplicate_of_id', '==', id).get();
      for (const d of dupes.docs) if (await inReview(d.get('batch_id'))) { visible = true; break; }
    }
    if (visible) out.push({ id, descriptionRaw: text(r.description_raw), counterpartyNameRaw: text(r.counterparty_name_raw) });
  }
  return out;
}

/** How many rows match, for paging. Same filters, same visibility rules. */
export async function countBankTransactions(
  db: Db, orgId: string, filter: BankTransactionFilter, requestId?: string,
): Promise<number> {
  void requestId;
  return (await matching(db, orgId, filter)).length;
}

/**
 * One row, current or not. The Banking transaction page shows a superseded or rejected row with
 * its standing rather than pretending it never existed (EVIDENCE_MODEL.md §5.2); the caller reads
 * `recordStatus`/`supersededBy` and says so. `null` when the id is not this organisation's — the
 * uniform not-found (§8.4).
 */
export async function loadBankTransaction(
  db: Db, orgId: string, transactionId: string, requestId?: string,
): Promise<(BankTransaction & { readonly balanceAfter: string | null; readonly reference: string | null; readonly postedDate: string | null }) | null> {
  void requestId;
  const r = await readRowById<Row>(db, orgId, 'bank_transactions', transactionId);
  if (!r) return null;
  return {
    ...toTransaction(r),
    balanceAfter: r.balance_after === null || r.balance_after === undefined ? null : String(r.balance_after),
    reference: r.reference ?? null,
    postedDate: r.posted_date ?? null,
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
  db: Db, orgId: string, requestId?: string,
): Promise<RecurringGroupRow[]> {
  void requestId;
  const rows = await readRows<Row>(db, orgId, 'recurring_payment_groups');
  // `ORDER BY expected_amount DESC, id`: numerically, so in Decimal.
  rows.sort((x, y) => new Decimal(String(y.expected_amount)).comparedTo(String(x.expected_amount)) || byText(x.id, y.id));
  return rows.map((r) => ({
    id: r.id,
    bankAccountId: r.bank_account_id ?? null,
    counterpartyKey: r.counterparty_key,
    direction: r.direction,
    cadence: r.cadence,
    expectedAmount: String(r.expected_amount),
    amountToleranceRatio: String(r.amount_tolerance_ratio),
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    occurrenceCount: Number(r.occurrence_count),
    nextExpected: r.next_expected ?? null,
    status: r.status,
  }));
}

/** The latest member of each group: its masked description and amount, to name the group by. */
export async function loadLatestGroupMembers(
  db: Db, orgId: string, groupIds: readonly string[], requestId?: string,
): Promise<Map<string, { description: string | null; amount: string; date: string; id: string }>> {
  void requestId;
  const out = new Map<string, { description: string | null; amount: string; date: string; id: string }>();
  if (groupIds.length === 0) return out;
  const unique = [...new Set(groupIds)];
  const rows: Row[] = [];
  for (let i = 0; i < unique.length; i += 30) {
    rows.push(...await readRows<Row>(db, orgId, 'bank_transactions', (q) => q
      .where('record_status', '==', 'accepted')
      .where('superseded_by', '==', null)
      .where('recurring_group_id', 'in', unique.slice(i, i + 30))));
  }
  rows.sort((x, y) => byText(y.transaction_date, x.transaction_date) || byText(y.id, x.id));
  for (const r of rows) {
    const key = r.recurring_group_id as string;
    if (!out.has(key)) {
      out.set(key, { id: r.id, description: r.description_normalized ?? null, amount: String(r.amount), date: r.transaction_date });
    }
  }
  return out;
}
