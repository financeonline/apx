import 'server-only';
import Decimal from 'decimal.js';
import type { DocumentData } from 'firebase-admin/firestore';
import { arg, type DbFunctions } from '../registry';
import { raise } from '../raise';
import { nowIso, orgCollection, orgRow } from '../schema';
import { runTx } from '../tx';
import { uidOf, type Db } from '../types';
import { requireOrg, requirePermission } from '../app/access';
import { prepareAudit } from '../app/audit';
import { prepareRecalculation } from '../app/jobs';
import {
  locateOrNotFound, prepareCategoryHistory, prepareRowAudit, readRow, rpcThrottle,
} from '../app/financials-helpers';

/**
 * `api.*` functions of the Banking area, ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8): the
 * two banking edits — each closes and opens `category_history` (`app.write_category_history`),
 * writes the `audit_diff` row events of `bank_transactions` and requests a recalculation in the same
 * transaction, because cash and P&L figures already on screen change — and the month's banking
 * summary, an aggregation computed here in Decimal over the month's rows (§5).
 */

type Row = DocumentData;

/** `bank_account_type` → transfer kind (ADR-028): derived from the two accounts, never asserted. */
function transferKind(thisType: unknown, pairType: unknown): string {
  const cash = (t: unknown) => t === 'current' || t === 'savings';
  if (cash(thisType) && cash(pairType)) return 'cash_transfer';
  if (pairType === 'credit_card' || thisType === 'credit_card') return 'card_repayment';
  if (pairType === 'loan' || thisType === 'loan') return 'loan_repayment';
  return 'other_transfer';
}

/** `api.mark_transfer(p_txn, p_pair)` → p_txn. `p_pair` null unmarks the row. */
async function mark_transfer(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db);
  const txnId = arg.str(args, 'p_txn');
  const pairId = arg.str(args, 'p_pair');
  const found = await locateOrNotFound(db.fs, 'bank_transactions', txnId);
  const org = found.orgId;
  await requirePermission(db, org, 'banking.reconcile');

  return runTx(db, async (tx) => {
    const txn = await readRow(tx, db.fs, org, 'bank_transactions', txnId!);
    let kind = 'none';
    let pair: Row | null = null;
    if (pairId !== null) {
      const pairSnap = await tx.get(orgRow(db.fs, org, 'bank_transactions', pairId));
      if (!pairSnap.exists) raise.notFound();
      if (pairId === txnId) raise.invalid('a transaction cannot be its own transfer pair');
      pair = pairSnap.data()!;
      // ADR-028: the kind is DERIVED from the two account types, never taken from the caller. Only
      // `cash_transfer` is excluded from cash metrics, so letting a user assert the kind would let
      // them make a real outflow disappear from the cash figures.
      const [thisAccount, pairAccount] = await Promise.all([
        tx.get(orgRow(db.fs, org, 'bank_accounts', String(txn.bank_account_id))),
        tx.get(orgRow(db.fs, org, 'bank_accounts', String(pair.bank_account_id))),
      ]);
      kind = transferKind(thisAccount.get('account_type') ?? null, pairAccount.get('account_type') ?? null);
    }

    const now = nowIso();
    const txnAfter = { ...txn, transfer_pair_id: pairId, transfer_kind: kind, is_transfer: kind !== 'none', updated_at: now };
    const audits = [await prepareRowAudit(db, 'bank_transactions', 'update', txn, txnAfter, tx)];
    let pairHistory: { write(t: FirebaseFirestore.Transaction): void } | null = null;
    if (pair) {
      // Both legs describe one movement, so both must carry the same verdict.
      audits.push(await prepareRowAudit(db, 'bank_transactions', 'update', pair,
        { ...pair, transfer_pair_id: txnId, transfer_kind: kind, is_transfer: true, updated_at: now }, tx));
      pairHistory = await prepareCategoryHistory(db, tx, org, pairId!, {
        categoryAccountId: null, isTransfer: true, transferKind: kind, source: 'user',
      });
    }
    const history = await prepareCategoryHistory(db, tx, org, txnId!, {
      categoryAccountId: (txn.category_account_id as string | null | undefined) ?? null,
      isTransfer: kind !== 'none', transferKind: kind, source: 'user',
    });
    const event = await prepareAudit(db, {
      organizationId: org, action: 'bank_txn.transfer_marked', targetTable: 'bank_transactions', targetId: txnId,
      after: { pair: pairId, transfer_kind: kind },
    }, tx);
    const recalc = await prepareRecalculation(db.fs, org, 'banking_edit', txnId, uidOf(db), tx);

    tx.update(orgRow(db.fs, org, 'bank_transactions', txnId!), {
      transfer_pair_id: pairId, transfer_kind: kind, is_transfer: kind !== 'none', updated_at: now,
    });
    if (pair) {
      tx.update(orgRow(db.fs, org, 'bank_transactions', pairId!), {
        transfer_pair_id: txnId, transfer_kind: kind, is_transfer: true, updated_at: now,
      });
      pairHistory!.write(tx);
    }
    history.write(tx);
    for (const a of audits) a.write(tx);
    event.write(tx);
    recalc.write(tx);
    return txnId!;
  });
}

/** `api.override_bank_category(p_txn, p_account)` → p_txn. Null clears the category. */
async function override_bank_category(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db);
  const txnId = arg.str(args, 'p_txn');
  const accountId = arg.str(args, 'p_account');
  const found = await locateOrNotFound(db.fs, 'bank_transactions', txnId);
  const org = found.orgId;
  await requirePermission(db, org, 'banking.reconcile');

  return runTx(db, async (tx) => {
    const before = await readRow(tx, db.fs, org, 'bank_transactions', txnId!);
    if (accountId !== null && !(await tx.get(orgRow(db.fs, org, 'accounts', accountId))).exists) raise.notFound();
    const now = nowIso();
    const after = { ...before, category_account_id: accountId, category_source: 'user', updated_at: now };
    const rowAudit = await prepareRowAudit(db, 'bank_transactions', 'update', before, after, tx);
    const history = await prepareCategoryHistory(db, tx, org, txnId!, {
      categoryAccountId: accountId, isTransfer: before.is_transfer === true,
      transferKind: String(before.transfer_kind ?? 'none'), source: 'user',
    });
    const event = await prepareAudit(db, {
      organizationId: org, action: 'bank_txn.recategorised', targetTable: 'bank_transactions', targetId: txnId,
      before, after: { category_account_id: accountId },
    }, tx);
    const recalc = await prepareRecalculation(db.fs, org, 'banking_edit', txnId, uidOf(db), tx);

    tx.update(orgRow(db.fs, org, 'bank_transactions', txnId!), { category_account_id: accountId, category_source: 'user', updated_at: now });
    history.write(tx);
    rowAudit.write(tx);
    event.write(tx);
    recalc.write(tx);
    return txnId!;
  });
}

// ── The month's banking summary ──────────────────────────────────────────────────────────────────

/**
 * A `sum(case when … then amount else 0 end)::text` of numeric(18,2) amounts: PostgreSQL's sum
 * takes the larger scale of its inputs, so it reads `0` when no row took the amount branch and
 * `n.nn` once one did. Kept exactly, so the page and the tests read the same strings as before.
 */
class ScaledSum {
  private total = new Decimal(0);
  private scaled = false;
  add(value: Decimal | null): void {
    if (value === null) return;
    this.total = this.total.plus(value);
    this.scaled = true;
  }
  text(): string {
    return this.scaled ? this.total.toFixed(2) : '0';
  }
}

const money = (v: unknown): string | null => (v === null || v === undefined ? null : new Decimal(String(v)).toFixed(2));
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `api.bank_period_summary(p_org, p_period)`: per account, per category and the statements covering
 * the month, from the month's accepted, current rows. `cash_transfer` legs leave money in/out as they
 * leave the engine's cash family (ADR-028) and are reported apart; every transfer kind is left out of
 * the category spend (ADR-047.12).
 */
async function bank_period_summary(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const org = arg.str(args, 'p_org');
  const periodId = arg.str(args, 'p_period');
  await requireOrg(db, org);
  await requirePermission(db, org, 'banking.view');
  const orgId = org!;
  const period = periodId ? await orgRow(db.fs, orgId, 'fiscal_periods', periodId).get() : null;
  if (!period?.exists) raise.notFound();
  const start = String(period.get('period_start'));
  const end = String(period.get('period_end'));

  const [txnSnap, batchSnap] = await Promise.all([
    orgCollection(db.fs, orgId, 'bank_transactions').where('period_id', '==', periodId)
      .where('record_status', '==', 'accepted').where('superseded_by', '==', null).get(),
    orgCollection(db.fs, orgId, 'import_batches').where('target_table', '==', 'bank_transactions')
      .where('status', '==', 'committed').where('rolled_back_at', '==', null).get(),
  ]);
  const txns = txnSnap.docs.map((d) => d.data());
  const categoryIds = [...new Set(txns.map((t) => t.category_account_id).filter((id): id is string => typeof id === 'string'))];
  const accountSnaps = categoryIds.length > 0
    ? await db.fs.getAll(...categoryIds.map((id) => orgRow(db.fs, orgId, 'accounts', id))) : [];
  const categoryOf = new Map(accountSnaps.filter((s) => s.exists).map((s) => [s.id, String(s.get('standard_category'))]));

  interface AccountAgg {
    inflow: ScaledSum; outflow: ScaledSum; transfersIn: ScaledSum; transfersOut: ScaledSum;
    rows: number; uncategorised: number; transfers: number; first: string; last: string; balance: Row | null;
  }
  const accounts = new Map<string, AccountAgg>();
  const categories = new Map<string, { inflow: ScaledSum; outflow: ScaledSum; rows: number }>();
  for (const t of txns) {
    const amount = new Decimal(String(t.amount));
    const cash = t.transfer_kind === 'cash_transfer';
    const key = String(t.bank_account_id);
    const a = accounts.get(key) ?? {
      inflow: new ScaledSum(), outflow: new ScaledSum(), transfersIn: new ScaledSum(), transfersOut: new ScaledSum(),
      rows: 0, uncategorised: 0, transfers: 0, first: String(t.transaction_date), last: String(t.transaction_date), balance: null,
    };
    a.inflow.add(amount.gt(0) && !cash ? amount : null);
    a.outflow.add(amount.lt(0) && !cash ? amount.neg() : null);
    a.transfersIn.add(amount.gt(0) && cash ? amount : null);
    a.transfersOut.add(amount.lt(0) && cash ? amount.neg() : null);
    // Every other row contributes the literal 0, which does not change the scale.
    a.rows += 1;
    const category = typeof t.category_account_id === 'string' ? categoryOf.get(t.category_account_id) ?? null : null;
    if (t.category_account_id === null || t.category_account_id === undefined || category === 'uncategorised') a.uncategorised += 1;
    if (t.is_transfer === true) a.transfers += 1;
    if (String(t.transaction_date) < a.first) a.first = String(t.transaction_date);
    if (String(t.transaction_date) > a.last) a.last = String(t.transaction_date);
    if (t.balance_after !== null && t.balance_after !== undefined) {
      const b = a.balance;
      if (!b || String(t.transaction_date) > String(b.transaction_date)
        || (t.transaction_date === b.transaction_date && String(t.id) > String(b.id))) a.balance = t;
    }
    accounts.set(key, a);

    if (t.is_transfer !== true) {
      const c = categories.get(category ?? 'uncategorised') ?? { inflow: new ScaledSum(), outflow: new ScaledSum(), rows: 0 };
      c.inflow.add(amount.gt(0) ? amount : null);
      c.outflow.add(amount.lt(0) ? amount.neg() : null);
      c.rows += 1;
      categories.set(category ?? 'uncategorised', c);
    }
  }

  const batches = batchSnap.docs.map((d) => d.data());
  const committedDesc = (a: Row, b: Row) => byText(String(b.committed_at ?? ''), String(a.committed_at ?? ''));
  const statements = batches
    .filter((b) => b.period_start !== null && b.period_end !== null && String(b.period_start) <= end && String(b.period_end) >= start)
    .sort(committedDesc)
    .map((b) => ({
      batch_id: b.id,
      bank_account_id: b.bank_account_id ?? null,
      period_start: b.period_start ?? null,
      period_end: b.period_end ?? null,
      committed_at: b.committed_at ?? null,
      statement_opening_balance: money(b.statement_opening_balance),
      statement_closing_balance: money(b.statement_closing_balance),
      extraction_method: b.extraction_method ?? null,
      // Did the rows reconcile to the printed balances at import (IMP-BAL-006/007)?
      unreconciled: (Array.isArray(b.batch_issues) ? b.batch_issues as Array<{ code?: unknown }> : [])
        .some((i) => i && (i.code === 'IMP-BAL-006' || i.code === 'IMP-BAL-007')),
    }));
  const latest = [...batches].sort(committedDesc)[0];

  return {
    period: { id: periodId, start, end },
    accounts: [...accounts.entries()].sort(([a], [b]) => byText(a, b)).map(([id, a]) => ({
      bank_account_id: id,
      inflow: a.inflow.text(), outflow: a.outflow.text(),
      transfers_in: a.transfersIn.text(), transfers_out: a.transfersOut.text(),
      row_count: a.rows, uncategorised_count: a.uncategorised, transfer_count: a.transfers,
      first_date: a.first, last_date: a.last,
      last_balance_after: a.balance ? money(a.balance.balance_after) : null,
      last_balance_date: a.balance ? String(a.balance.transaction_date) : null,
    })),
    categories: [...categories.entries()].sort(([a], [b]) => byText(a, b)).map(([category, c]) => ({
      standard_category: category, inflow: c.inflow.text(), outflow: c.outflow.text(), row_count: c.rows,
    })),
    statements,
    latest_statement: latest
      ? { committed_at: latest.committed_at ?? null, period_end: latest.period_end ?? null, bank_account_id: latest.bank_account_id ?? null }
      : null,
    // No live provider exists. This is stated by the database so no page can drift into claiming
    // otherwise (CD-21, REQ-BK-10).
    source: 'imported_statements',
  };
}

export const functions: DbFunctions = {
  mark_transfer,
  override_bank_category,
  bank_period_summary,
};
