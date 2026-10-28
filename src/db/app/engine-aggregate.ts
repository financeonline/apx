import 'server-only';
import { Decimal } from '@/core/money/decimal';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { arg, type DbFunctions } from '../registry';
import { orgCollection, nowIso } from '../schema';
import { monthStart } from './shared';
import { requireServer } from './scope';

/**
 * The engine's aggregation reads (FINANCIAL_ENGINE.md §2.2, §2.4 step 4): `app.aggregate_periods`,
 * `app.aggregate_transfer_legs`, `app.bank_daily_movements`, `app.batch_coverage` and the instant a
 * chunk pins them to, behind their `api_server` wrappers.
 *
 * On PostgreSQL these were GROUP BY / SUM queries. Firestore has no aggregation that groups, so each
 * is computed here over the organisation's rows: the rows are read by period (or by date), the
 * SQL's row filter is applied exactly — `record_status = 'accepted'`, `superseded_by is null`,
 * `created_at <= p_aggregated_at`, `status <> 'void'` for invoices — and the sums are taken with
 * decimal.js. The result is the same rows with the same columns the SQL returned: sums of
 * `numeric(18,2)` columns as decimal strings with two places (what the SQL's `sum` printed), counts
 * as numbers, dates as `YYYY-MM-DD`, NULL as `null`. `core/db/server-rpc.ts` sorts the rows on the
 * grouping key, so the engine sees them in a total order whatever order this returns.
 *
 * The joins are kept as the SQL wrote them: the ledger and period-balance branches INNER-join
 * `accounts` (a row whose account is gone is not counted), the bank branch LEFT-joins the category
 * account, and the invoice and bank branches fold a merged counterparty into the one it was merged
 * into (`coalesce(c.merged_into_id, counterparty_id)`).
 */

/** Firestore `in` takes at most 30 values. */
const IN_LIMIT = 30;

const ZERO = new Decimal(0);
const dec = (v: unknown): Decimal => (v === null || v === undefined || v === '' ? ZERO : new Decimal(String(v)));
const money = (d: Decimal): string => d.toFixed(2);
const time = (v: unknown): number => {
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

/** `p_aggregated_at`, defaulting to now as the SQL default did. */
function instantArg(args: Record<string, unknown>): number {
  const raw = arg.str(args, 'p_aggregated_at');
  if (raw === null) return Date.now();
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new Error(`p_aggregated_at is not a timestamp: ${raw}`);
  return t;
}

/** The row filter every branch shares: accepted, current, and visible at the aggregation instant. */
function visible(row: DocumentData, at: number): boolean {
  return row.record_status === 'accepted' && (row.superseded_by ?? null) === null && time(row.created_at) <= at;
}

interface PeriodRow { id: string; period_start: string }

/** `periods`: the fiscal periods whose first day is in [month of from, month of to]. */
async function periodsBetween(fs: Firestore, orgId: string, from: string, to: string): Promise<PeriodRow[]> {
  const snap = await orgCollection(fs, orgId, 'fiscal_periods')
    .where('period_start', '>=', monthStart(from))
    .where('period_start', '<=', monthStart(to))
    .get();
  return snap.docs.map((d) => ({ id: d.id, period_start: String(d.get('period_start')) }));
}

/** Every row of `table` in the given periods (read in `in` chunks; filtered by the caller). */
async function rowsInPeriods(
  fs: Firestore, orgId: string, table: 'ledger_entries' | 'period_balances' | 'invoices' | 'bank_transactions',
  periodIds: readonly string[],
): Promise<DocumentData[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < periodIds.length; i += IN_LIMIT) chunks.push(periodIds.slice(i, i + IN_LIMIT));
  const snaps = await Promise.all(chunks.map((chunk) => orgCollection(fs, orgId, table).where('period_id', 'in', chunk).get()));
  return snaps.flatMap((s) => s.docs.map((d) => d.data()));
}

async function byId(fs: Firestore, orgId: string, table: 'accounts' | 'counterparties'): Promise<Map<string, DocumentData>> {
  const snap = await orgCollection(fs, orgId, table).get();
  return new Map(snap.docs.map((d) => [d.id, d.data()]));
}

/** One GROUP BY: the key's columns, then running sums. */
class Groups<T> {
  private readonly map = new Map<string, T>();
  constructor(private readonly start: () => T) {}
  at(key: ReadonlyArray<unknown>): T {
    const k = JSON.stringify(key);
    let g = this.map.get(k);
    if (!g) { g = this.start(); this.map.set(k, g); }
    return g;
  }
  values(): T[] { return [...this.map.values()]; }
}

const minDate = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : (b < a ? b : a));
const maxDate = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : (b > a ? b : a));

interface AggregateRow {
  period_id: string;
  source: 'ledger' | 'period_balances' | 'invoices' | 'bank';
  standard_category: string | null;
  account_id: string | null;
  counterparty_id: string | null;
  bank_account_id: string | null;
  balance_kind: string | null;
  balance_basis: string | null;
  invoice_type: string | null;
  transfer_kind: string | null;
  unpaired_transfer: boolean;
  debit: string;
  credit: string;
  amount: string;
  row_count: number;
  min_date: string | null;
  max_date: string | null;
  fallback_rows: number;
}

interface Acc {
  key: Omit<AggregateRow, 'debit' | 'credit' | 'amount' | 'row_count' | 'min_date' | 'max_date' | 'fallback_rows' | 'unpaired_transfer'> | null;
  debit: Decimal; credit: Decimal; amount: Decimal; count: number;
  min: string | null; max: string | null; fallback: number; unpaired: boolean;
}

const acc = (): Acc => ({
  key: null, debit: ZERO, credit: ZERO, amount: ZERO, count: 0, min: null, max: null, fallback: 0, unpaired: false,
});

function emit(groups: Groups<Acc>): AggregateRow[] {
  return groups.values().map((g) => ({
    ...g.key!,
    unpaired_transfer: g.unpaired,
    debit: money(g.debit), credit: money(g.credit), amount: money(g.amount),
    row_count: g.count, min_date: g.min, max_date: g.max, fallback_rows: g.fallback,
  }));
}

/** `app.invoice_net`: the subtotal, unless it is a zero beside a positive total; else total − VAT. */
export function invoiceNet(subtotal: unknown, tax: unknown, total: unknown): Decimal {
  const hasSubtotal = subtotal !== null && subtotal !== undefined && subtotal !== '';
  const hasTax = tax !== null && tax !== undefined && tax !== '';
  if (hasSubtotal && !(dec(subtotal).isZero() && dec(total).gt(0))) return dec(subtotal);
  if (hasTax) return dec(total).minus(dec(tax));
  return dec(total);
}

/** `app.invoice_net_is_vat_fallback`: the net came from the total because nothing else was stated. */
export function invoiceNetIsVatFallback(subtotal: unknown, tax: unknown, total: unknown): boolean {
  const hasSubtotal = subtotal !== null && subtotal !== undefined && subtotal !== '';
  const hasTax = tax !== null && tax !== undefined && tax !== '';
  return !(hasSubtotal && !(dec(subtotal).isZero() && dec(total).gt(0))) && !hasTax;
}

/** `app.aggregate_periods`: one row per period × source × category × account × counterparty × bank account. */
export async function aggregatePeriods(
  fs: Firestore, orgId: string, from: string, to: string, at: number,
): Promise<AggregateRow[]> {
  const periods = await periodsBetween(fs, orgId, from, to);
  if (periods.length === 0) return [];
  const ids = periods.map((p) => p.id);
  const [accounts, counterparties, ledger, balances, invoices, bank] = await Promise.all([
    byId(fs, orgId, 'accounts'),
    byId(fs, orgId, 'counterparties'),
    rowsInPeriods(fs, orgId, 'ledger_entries', ids),
    rowsInPeriods(fs, orgId, 'period_balances', ids),
    rowsInPeriods(fs, orgId, 'invoices', ids),
    rowsInPeriods(fs, orgId, 'bank_transactions', ids),
  ]);
  const folded = (counterpartyId: unknown): string | null => {
    if (counterpartyId === null || counterpartyId === undefined) return null;
    const c = counterparties.get(String(counterpartyId));
    return (c?.merged_into_id as string | null | undefined) ?? String(counterpartyId);
  };
  const out: AggregateRow[] = [];

  // ledger: inner join accounts; debit − credit, raw (the sign rule is the engine's).
  const ledgerGroups = new Groups(acc);
  for (const e of ledger) {
    if (!visible(e, at)) continue;
    const account = accounts.get(String(e.account_id));
    if (!account) continue;
    const key = {
      period_id: String(e.period_id), source: 'ledger' as const, standard_category: (account.standard_category as string) ?? null,
      account_id: String(e.account_id), counterparty_id: (e.counterparty_id as string | null) ?? null, bank_account_id: null,
      balance_kind: null, balance_basis: null, invoice_type: null, transfer_kind: null,
    };
    const g = ledgerGroups.at([key.period_id, key.standard_category, key.account_id, key.counterparty_id]);
    g.key ??= key;
    const amount = dec(e.amount);
    const debit = e.direction === 'debit';
    if (debit) g.debit = g.debit.plus(amount); else g.credit = g.credit.plus(amount);
    g.amount = debit ? g.amount.plus(amount) : g.amount.minus(amount);
    g.count += 1;
    g.min = minDate(g.min, e.entry_date as string); g.max = maxDate(g.max, e.entry_date as string);
  }
  out.push(...emit(ledgerGroups));

  // period_balances: inner join accounts; the stated closing balances, summed.
  const balanceGroups = new Groups(acc);
  for (const b of balances) {
    if (!visible(b, at)) continue;
    const account = accounts.get(String(b.account_id));
    if (!account) continue;
    const key = {
      period_id: String(b.period_id), source: 'period_balances' as const,
      standard_category: (account.standard_category as string) ?? null, account_id: String(b.account_id),
      counterparty_id: null, bank_account_id: null, balance_kind: (b.balance_kind as string) ?? null,
      balance_basis: (b.balance_basis as string) ?? null, invoice_type: null, transfer_kind: null,
    };
    const g = balanceGroups.at([key.period_id, key.standard_category, key.account_id, key.balance_kind, key.balance_basis]);
    g.key ??= key;
    g.debit = g.debit.plus(dec(b.debit_total));
    g.credit = g.credit.plus(dec(b.credit_total));
    g.amount = g.amount.plus(dec(b.closing_balance));
    g.count += 1;
    g.min = minDate(g.min, b.period_start as string); g.max = maxDate(g.max, b.period_start as string);
  }
  out.push(...emit(balanceGroups));

  // invoices: no account (the engine derives the category); VAT, paid and net; void excluded.
  const invoiceGroups = new Groups(acc);
  for (const i of invoices) {
    if (!visible(i, at) || i.status === 'void') continue;
    const key = {
      period_id: String(i.period_id), source: 'invoices' as const, standard_category: null, account_id: null,
      counterparty_id: folded(i.counterparty_id), bank_account_id: null, balance_kind: null, balance_basis: null,
      invoice_type: (i.invoice_type as string) ?? null, transfer_kind: null,
    };
    const g = invoiceGroups.at([key.period_id, key.counterparty_id, key.invoice_type]);
    g.key ??= key;
    g.debit = g.debit.plus(dec(i.tax_amount));
    g.credit = g.credit.plus(dec(i.amount_paid));
    g.amount = g.amount.plus(invoiceNet(i.subtotal, i.tax_amount, i.total_amount));
    g.count += 1;
    if (invoiceNetIsVatFallback(i.subtotal, i.tax_amount, i.total_amount)) g.fallback += 1;
    g.min = minDate(g.min, i.issue_date as string); g.max = maxDate(g.max, i.issue_date as string);
  }
  out.push(...emit(invoiceGroups));

  // bank: left join the category account; transfer_kind is a DIMENSION, never a filter (ADR-028).
  const bankGroups = new Groups(acc);
  for (const t of bank) {
    if (!visible(t, at)) continue;
    const categoryId = (t.category_account_id as string | null | undefined) ?? null;
    const category = categoryId ? accounts.get(categoryId) : undefined;
    const key = {
      period_id: String(t.period_id), source: 'bank' as const,
      standard_category: (category?.standard_category as string | undefined) ?? null, account_id: categoryId,
      counterparty_id: folded(t.counterparty_id), bank_account_id: (t.bank_account_id as string | null) ?? null,
      balance_kind: null, balance_basis: null, invoice_type: null, transfer_kind: (t.transfer_kind as string | null) ?? null,
    };
    const g = bankGroups.at([key.period_id, key.standard_category, key.account_id, key.counterparty_id, key.bank_account_id, key.transfer_kind]);
    g.key ??= key;
    const amount = dec(t.amount);
    if (amount.gt(0)) g.debit = g.debit.plus(amount);
    if (amount.lt(0)) g.credit = g.credit.minus(amount);
    g.amount = g.amount.plus(amount);
    g.count += 1;
    if (t.is_transfer === true && (t.transfer_pair_id ?? null) === null) g.unpaired = true;
    g.min = minDate(g.min, t.transaction_date as string); g.max = maxDate(g.max, t.transaction_date as string);
  }
  out.push(...emit(bankGroups));
  return out;
}

/** `app.aggregate_transfer_legs`: transfer legs per period, bank account and kind. */
export async function aggregateTransferLegs(
  fs: Firestore, orgId: string, from: string, to: string, at: number,
): Promise<Array<Record<string, unknown>>> {
  const periods = await periodsBetween(fs, orgId, from, to);
  if (periods.length === 0) return [];
  const rows = await rowsInPeriods(fs, orgId, 'bank_transactions', periods.map((p) => p.id));
  const groups = new Groups(() => ({ key: null as null | [string, string, string], inflow: ZERO, outflow: ZERO, count: 0 }));
  for (const t of rows) {
    if (!visible(t, at) || t.is_transfer !== true) continue;
    const key: [string, string, string] = [String(t.period_id), String(t.bank_account_id), String(t.transfer_kind)];
    const g = groups.at(key);
    g.key ??= key;
    const amount = dec(t.amount);
    if (amount.gt(0)) g.inflow = g.inflow.plus(amount);
    if (amount.lt(0)) g.outflow = g.outflow.minus(amount);
    g.count += 1;
  }
  return groups.values().map((g) => ({
    period_id: g.key![0], bank_account_id: g.key![1], transfer_kind: g.key![2],
    inflow: money(g.inflow), outflow: money(g.outflow), row_count: g.count,
  }));
}

/** `app.bank_daily_movements`: every accepted, current bank row summed per account and day, to `to`. */
export async function bankDailyMovements(
  fs: Firestore, orgId: string, to: string, at: number,
): Promise<Array<Record<string, unknown>>> {
  const snap = await orgCollection(fs, orgId, 'bank_transactions').where('transaction_date', '<=', to).get();
  const groups = new Groups(() => ({ key: null as null | [string, string], amount: ZERO, count: 0 }));
  for (const d of snap.docs) {
    const t = d.data();
    if (!visible(t, at)) continue;
    const key: [string, string] = [String(t.bank_account_id), String(t.transaction_date)];
    const g = groups.at(key);
    g.key ??= key;
    g.amount = g.amount.plus(dec(t.amount));
    g.count += 1;
  }
  return groups.values().map((g) => ({
    bank_account_id: g.key![0], transaction_date: g.key![1], amount: money(g.amount), row_count: g.count,
  }));
}

/** `app.batch_record_assurance`: what a balance batch's records are worth, from how it was read. */
function batchRecordAssurance(b: DocumentData): string {
  if (b.extraction_method === 'pdf_claude') return 'inferred';
  if (b.extraction_method === 'pdf_text') {
    const issues = Array.isArray(b.batch_issues) ? (b.batch_issues as Array<{ code?: unknown }>) : [];
    return issues.some((i) => i?.code === 'IMP-BAL-006' || i?.code === 'IMP-BAL-007') ? 'calculated' : 'verified';
  }
  return 'verified';
}

const BALANCE_KIND: Record<string, string> = {
  trial_balance: 'trial_balance', pnl_report: 'pnl_report', balance_sheet: 'balance_sheet',
};

/** The confirmation value at `confirmations -> code -> 'value' ->> field`, as text. */
function confirmation(b: DocumentData, code: string, field: string): string | null {
  const c = (b.confirmations as Record<string, { value?: Record<string, unknown> } | undefined> | undefined)?.[code];
  const v = c?.value?.[field];
  return v === null || v === undefined ? null : String(v);
}

/** The latest attestation of a batch for one month: `order by attested_at desc, id desc limit 1`. */
function latestAttestation(attestations: readonly DocumentData[], month: string): DocumentData | null {
  let best: DocumentData | null = null;
  for (const a of attestations) {
    if (a.period_start !== month) continue;
    if (!best) { best = a; continue; }
    const ta = time(a.attested_at); const tb = time(best.attested_at);
    if (ta > tb || (ta === tb && String(a.id) > String(best.id))) best = a;
  }
  return best;
}

/** `app.batch_coverage`: the committed batches that declare a range overlapping [from, to]. */
export async function batchCoverage(
  fs: Firestore, orgId: string, from: string, to: string,
): Promise<Array<Record<string, unknown>>> {
  const fromMonth = monthStart(from);
  const toMonth = monthStart(to);
  const toEnd = (() => {
    const y = Number(toMonth.slice(0, 4)); const m = Number(toMonth.slice(5, 7));
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  })();
  const snap = await orgCollection(fs, orgId, 'import_batches').where('status', '==', 'committed').get();
  const batches = snap.docs.map((d) => d.data()).filter((b) => b.period_start != null && b.period_end != null
    && String(b.period_end) >= fromMonth && String(b.period_start) <= toEnd);

  const rows = await Promise.all(batches.map(async (b) => {
    const balances = b.target_table === 'period_balances';
    const invoices = b.target_table === 'invoices';
    const attestations = balances || invoices
      ? (await orgCollection(fs, orgId, 'report_completeness_attestations').where('import_batch_id', '==', b.id).get())
        .docs.map((d) => d.data())
      : [];

    let rowMonths: string[] | null = null;
    let completeness: Record<string, string> | null = null;
    if (balances) {
      const pb = await orgCollection(fs, orgId, 'period_balances').where('import_batch_id', '==', b.id).get();
      rowMonths = [...new Set(pb.docs.map((d) => d.data())
        .filter((r) => r.record_status === 'accepted' && (r.superseded_by ?? null) === null)
        .map((r) => String(r.period_start)))].sort();
      completeness = {};
      const imported = confirmation(b, 'IMP-TB-016', 'report_complete');
      for (const m of rowMonths) {
        const attested = latestAttestation(attestations, m);
        const answer = (attested?.coverage as string | null | undefined)
          ?? (imported === 'complete' || imported === 'partial' ? imported : null);
        if (answer !== null && answer !== undefined) completeness[m] = answer;
      }
    }

    let openingConfirmed: boolean | null = null;
    if (invoices) {
      const attested = latestAttestation(attestations, monthStart(String(b.period_start)));
      if (attested) openingConfirmed = attested.coverage === 'complete';
      else {
        const opening = confirmation(b, 'IMP-INV-013', 'opening');
        openingConfirmed = opening === 'complete' ? true : opening === 'partial' ? false : null;
      }
    }

    return {
      target_table: b.target_table,
      import_type: b.import_type,
      balance_kind: BALANCE_KIND[String(b.import_type)] ?? null,
      bank_account_id: b.bank_account_id ?? null,
      invoice_list_kind: b.invoice_list_kind ?? null,
      period_start: b.period_start,
      period_end: b.period_end,
      committed_at: b.committed_at ?? null,
      batch_id: b.id,
      balance_basis: b.balance_basis ?? null,
      fiscal_year_start_month_at_commit: b.fiscal_year_start_month_at_commit ?? null,
      row_months: rowMonths,
      completeness_by_month: completeness,
      record_assurance: balances ? batchRecordAssurance(b) : null,
      opening_confirmed: openingConfirmed,
    };
  }));
  // `order by committed_at desc` (NULLs first, as PostgreSQL sorts them descending).
  return rows.sort((a, b) => time(b.committed_at ?? '9999') - time(a.committed_at ?? '9999'));
}

export const aggregateFunctions: DbFunctions = {
  /** `api_server.aggregate_periods`. */
  async aggregate_periods(db, args) {
    requireServer(db);
    return aggregatePeriods(db.fs, arg.req(args, 'p_org'), arg.req(args, 'p_from'), arg.req(args, 'p_to'), instantArg(args));
  },

  /** `api_server.aggregate_transfer_legs`. */
  async aggregate_transfer_legs(db, args) {
    requireServer(db);
    return aggregateTransferLegs(db.fs, arg.req(args, 'p_org'), arg.req(args, 'p_from'), arg.req(args, 'p_to'), instantArg(args));
  },

  /** `api_server.bank_daily_movements`. */
  async bank_daily_movements(db, args) {
    requireServer(db);
    return bankDailyMovements(db.fs, arg.req(args, 'p_org'), arg.req(args, 'p_to'), instantArg(args));
  },

  /** `api_server.batch_coverage`. */
  async batch_coverage(db, args) {
    requireServer(db);
    return batchCoverage(db.fs, arg.req(args, 'p_org'), arg.req(args, 'p_from'), arg.req(args, 'p_to'));
  },

  /**
   * `api_server.aggregation_instant`: the instant a chunk aggregates as of. On PostgreSQL this was
   * the transaction's own `now()`, the clock that stamped `created_at`. Here every `created_at` is
   * stamped by a server with `nowIso()`, so the server's clock is that clock (ADR-063's point — one
   * clock decides visibility — holds as long as the app servers keep NTP time).
   */
  async aggregation_instant(db) {
    requireServer(db);
    return nowIso();
  },
};
