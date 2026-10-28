/**
 * Six organisations for ADR-120 (receivables, payables, working capital and the cash carry), seeded
 * as raw accepted records under committed batches — exactly what an import leaves — and computed
 * ONLY by the real `calculation.run` job through the real queue. Nothing here writes a
 * `metric_snapshots` row: every figure the tests read, the engine produced.
 *
 * Every expected number is hand-computed in the comments. Periods: June–August 2026 complete; the
 * run's `asOf` is 2026-09-15, so September is the current (partial) period.
 *
 *   BANK     bank statements only, burning cash      — the cash chain and runway
 *   INVBANK  sales + purchase invoices, plus bank    — invoice-basis AR/AP, days, overdue, WC
 *   INVONLY  sales invoices only, no bank account    — payables unknown, WC unknown, cash unknown
 *   LEDGER   GL with an opening-balance journal     — ledger-basis AR/AP (ADR-027.3 item 3)
 *   TB       cumulative trial balances + bank        — balance-basis AR/AP, a stated zero, WC terms
 *   EMPTY    an organisation with nothing            — no zero anywhere
 *   HISTORY  GL from March, statements from June     — history first, banking later; the
 *            first statement's own opening balance (CD-06) with nothing typed on the account
 */
import { expect } from 'vitest';
import { periodId as derivedPeriodId } from '@/db/app/shared';
import { orgCollection, orgRow } from '@/db/schema';
import { drainJobs } from '@/modules/jobs';
import { createAuthUser, fs } from '../integration/setup';
import { Decimal } from '@/core/money/decimal';
import { metricValueText } from './engine-dump';
import {
  jobsOf, seedAccepted, seedBankAccount, seedBankTransaction, seedBatch, seedCounterparty, seedDocument, seedImportRow,
  seedInvoice, seedJob, seedLedgerEntry, seedOrg, seedPeriodBalance,
} from './seed';

export const AS_OF = '2026-09-15';
/**
 * When every fixture batch was committed: FIXED, and before `AS_OF`, as in production (ADR-123,
 * audit F-9). The fixtures used `now()`, which is always after the run's as-of date and turned the
 * current-period test into one that passed only until the wall clock moved on.
 */
export const COMMITTED_AT = '2026-09-10T10:00:00Z';
export const MONTHS = [
  { key: 'jun', start: '2026-06-01', end: '2026-06-30' },
  { key: 'jul', start: '2026-07-01', end: '2026-07-31' },
  { key: 'aug', start: '2026-08-01', end: '2026-08-31' },
] as const;

export type FixtureKey = 'BANK' | 'INVBANK' | 'INVONLY' | 'LEDGER' | 'TB' | 'EMPTY' | 'HISTORY';

async function account(org: string, category: string): Promise<string> {
  const snap = await orgCollection(fs(), org, 'accounts').where('standard_category', '==', category).get();
  const rows = snap.docs.map((d) => d.data()).sort((a, b) =>
    Number(b.is_system === true) - Number(a.is_system === true) || String(a.id).localeCompare(String(b.id)));
  return String(rows[0]?.id ?? '');
}

const document = (org: string, tag: string, kind: string): Promise<string> => seedDocument(org, `${tag}.csv`, kind);

/** The reviewer's IMP-INV-013 answer, as a real commit stores it. */
const openingComplete = (): Record<string, unknown> =>
  ({ 'IMP-INV-013': { by: null, at: new Date().toISOString(), value: { opening: 'complete' } } });

function batch(org: string, doc: string, o: {
  importType: string; target: string; start: string; end: string;
  bankAccount?: string; listKind?: 'full' | 'open_items'; balanceBasis?: 'cumulative' | 'movement';
}): Promise<string> {
  // R-2: the fixtures' invoice lists are complete exports, confirmed to hold every invoice unpaid at their start.
  return seedBatch(org, {
    importType: o.importType, target: o.target, start: o.start, end: o.end, committedAt: COMMITTED_AT, documentId: doc,
    bankAccountId: o.bankAccount ?? null, listKind: o.listKind ?? null, balanceBasis: o.balanceBasis ?? null,
    confirmations: o.target === 'invoices' ? openingComplete() : {},
  });
}

let rowNumber = 0;
async function importRow(org: string, batchId: string): Promise<string> {
  rowNumber += 1;
  return seedImportRow(org, batchId);
}

const accepted = (org: string, table: string, id: string, batchId: string): Promise<void> => seedAccepted(org, table, id, batchId);

/**
 * A current account with statements for June–August; `moves[m]` are that month's signed amounts.
 * `openingBalance` is typed on the account (dated 05-31); `statementOpening`, when given, is printed
 * on the JUNE statement instead — the first source CD-06 names.
 */
async function bankStatements(
  org: string, openingBalance: string | null, moves: readonly (readonly string[])[], statementOpening: string | null = null,
): Promise<string> {
  const bank = await seedBankAccount(org, {
    name: 'Main', accountType: 'current', openingBalance, openingBalanceDate: openingBalance === null ? null : '2026-05-31',
  });
  for (const [m, month] of MONTHS.entries()) {
    const doc = await document(org, `bank-${month.key}`, 'bank_statement');
    const b = await batch(org, doc, { importType: 'bank_statement', target: 'bank_transactions', start: month.start, end: month.end, bankAccount: bank });
    if (m === 0 && statementOpening !== null) {
      await orgRow(fs(), org, 'import_batches', b).update({ statement_opening_balance: new Decimal(statementOpening).toFixed(2) });
    }
    for (const [i, amount] of (moves[m] ?? []).entries()) {
      const row = await importRow(org, b);
      const id = await seedBankTransaction(org, {
        bankAccountId: bank, date: `${month.start.slice(0, 8)}${String(10 + i).padStart(2, '0')}`, amount,
        description: `mv ${m}-${i}`, documentId: doc, batchId: b, importRowId: row, sourceRef: `b${m}-${i}`,
      });
      await accepted(org, 'bank_transactions', id, b);
    }
  }
  return bank;
}

interface InvoiceSeed {
  readonly type: 'sales' | 'sales_credit_note' | 'purchase';
  readonly party: string;
  readonly number: string;
  readonly issue: string;
  readonly due: string | null;
  readonly subtotal: string;
  readonly tax: string;
  readonly total: string;
  readonly paid: string;
  readonly paidDate: string | null;
  readonly status: 'open' | 'partially_paid' | 'paid' | 'void';
}

/**
 * A committed full invoice list and its rows, each with the `accepted` lifecycle event a real commit
 * writes — the evidence resolver reconstructs what a run saw from those events (EVIDENCE_MODEL.md §3).
 */
async function invoiceList(org: string, importType: 'sales_invoices' | 'purchase_invoices', rows: readonly InvoiceSeed[]): Promise<void> {
  const doc = await document(org, importType, 'invoice');
  const b = await batch(org, doc, { importType, target: 'invoices', start: '2026-06-01', end: '2026-08-31', listKind: 'full' });
  for (const r of rows) {
    const row = await importRow(org, b);
    const id = await seedInvoice(org, {
      type: r.type, counterpartyId: r.party, number: r.number, issue: r.issue, due: r.due, subtotal: r.subtotal,
      tax: r.tax, total: r.total, paid: r.paid, paidDate: r.paidDate, status: r.status,
      documentId: doc, batchId: b, importRowId: row, sourceRef: `inv${rowNumber}`,
    });
    await accepted(org, 'invoices', id, b);
  }
}

/**
 * The invoice set shared by INVBANK and INVONLY.
 *
 *   S1  sales  issued 06-05, total 1,200.00 (1,000 + 200 VAT), due 07-05, PAID 07-01 in full
 *   S2  sales  issued 07-10, total 2,400.00, due 08-09, unpaid
 *   S3  sales  issued 08-03, total 3,600.00, due 09-02, 1,000.00 paid with no paid date (payment_date_unknown)
 *   C1  credit issued 08-20, total   600.00 (500 + 100 VAT), due 08-20, unapplied
 *   V1  sales  issued 08-12, total 9,999.00, VOID — in nothing
 *   P1  purchase issued 06-12, total 600.00, due 07-12, PAID 07-10
 *   P2  purchase issued 08-15, total 900.00, due 08-25, unpaid
 *
 * receivables  Jun 30: S1 1,200 (paid AFTER the date)          = 1,200.00, overdue 0
 *              Jul 31: S2 2,400                                 = 2,400.00, overdue 0
 *              Aug 31: S2 2,400 + S3 2,600 − C1 600             = 4,400.00, overdue S2 − C1 = 1,800.00
 *              Sep 15 (as-of): the same three, all past due    = 4,400.00, overdue 4,400.00
 * payables     Jun 30: P1 600 · Jul 31: 0 (a stated zero) · Aug 31: P2 900, overdue 900
 * receivables_days Aug: 4,400 / (1,200 + 2,400 + 3,600 − 600) × 91.25 = 4,400 / 6,600 × 91.25 = 60.83 → 61
 */
async function invoiceSet(org: string, withPurchases: boolean): Promise<void> {
  const acme = await seedCounterparty(org, { name: 'Acme Ltd', kind: 'customer' });
  const beta = await seedCounterparty(org, { name: 'Beta plc', kind: 'customer' });
  await invoiceList(org, 'sales_invoices', [
    { type: 'sales', party: acme, number: 'S1', issue: '2026-06-05', due: '2026-07-05', subtotal: '1000', tax: '200', total: '1200', paid: '1200', paidDate: '2026-07-01', status: 'paid' },
    { type: 'sales', party: beta, number: 'S2', issue: '2026-07-10', due: '2026-08-09', subtotal: '2000', tax: '400', total: '2400', paid: '0', paidDate: null, status: 'open' },
    { type: 'sales', party: acme, number: 'S3', issue: '2026-08-03', due: '2026-09-02', subtotal: '3000', tax: '600', total: '3600', paid: '1000', paidDate: null, status: 'partially_paid' },
    { type: 'sales_credit_note', party: acme, number: 'C1', issue: '2026-08-20', due: '2026-08-20', subtotal: '500', tax: '100', total: '600', paid: '0', paidDate: null, status: 'open' },
    { type: 'sales', party: beta, number: 'V1', issue: '2026-08-12', due: '2026-08-12', subtotal: '9999', tax: '0', total: '9999', paid: '0', paidDate: null, status: 'void' },
  ]);
  if (withPurchases) {
    const parts = await seedCounterparty(org, { name: 'Parts Co', kind: 'supplier', defaultExpenseCategory: 'cost_of_sales' });
    await invoiceList(org, 'purchase_invoices', [
      { type: 'purchase', party: parts, number: 'P1', issue: '2026-06-12', due: '2026-07-12', subtotal: '500', tax: '100', total: '600', paid: '600', paidDate: '2026-07-10', status: 'paid' },
      { type: 'purchase', party: parts, number: 'P2', issue: '2026-08-15', due: '2026-08-25', subtotal: '750', tax: '150', total: '900', paid: '0', paidDate: null, status: 'open' },
    ]);
  }
}

/**
 * LEDGER — GL for June–August with an opening-balance journal on 06-01.
 *
 *   opening   receivables Dr 5,000 · payables Cr 2,000 · equity Cr 3,000        (is_opening_balance)
 *   each month: sales on account (Dr receivables / Cr revenue), receipts (Dr cash / Cr receivables),
 *               purchases on account (Dr cost_of_sales / Cr payables 1,000), payments (Dr payables / Cr cash 800)
 *   sales    Jun 4,000 · Jul 3,000 · Aug 2,000;   receipts Jun 3,000 · Jul 2,500 · Aug 6,000
 *
 *   receivables Jun 5,000 + 4,000 − 3,000 = 6,000.00 · Jul + 3,000 − 2,500 = 6,500.00 · Aug + 2,000 − 6,000 = 2,500.00
 *   payables    Jun 2,000 + 1,000 − 800   = 2,200.00 · Jul 2,400.00 · Aug 2,600.00
 */
async function ledgerOrg(org: string): Promise<void> {
  const docs: Array<{ doc: string; batch: string }> = [];
  for (const month of MONTHS) {
    const doc = await document(org, `gl-${month.key}`, 'general_ledger');
    docs.push({ doc, batch: await batch(org, doc, { importType: 'general_ledger', target: 'ledger_entries', start: month.start, end: month.end }) });
  }
  const post = async (m: number, day: string, category: string, direction: 'debit' | 'credit', amount: string, opening = false) => {
    const { doc, batch: b } = docs[m]!;
    const row = await importRow(org, b);
    const id = await seedLedgerEntry(org, {
      date: `${MONTHS[m]!.start.slice(0, 8)}${day}`, accountId: await account(org, category), direction, amount,
      documentId: doc, batchId: b, importRowId: row, sourceRef: `gl${rowNumber}`, isOpeningBalance: opening,
    });
    await accepted(org, 'ledger_entries', id, b);
  };
  await post(0, '01', 'receivables', 'debit', '5000', true);
  await post(0, '01', 'payables', 'credit', '2000', true);
  await post(0, '01', 'equity', 'credit', '3000', true);
  const sales = ['4000', '3000', '2000'];
  const receipts = ['3000', '2500', '6000'];
  for (const [m, month] of MONTHS.entries()) {
    const last = month.end.slice(8, 10);
    await post(m, '05', 'receivables', 'debit', sales[m]!);
    await post(m, '05', 'revenue', 'credit', sales[m]!);
    await post(m, '15', 'cash', 'debit', receipts[m]!);
    await post(m, '15', 'receivables', 'credit', receipts[m]!);
    await post(m, '20', 'cost_of_sales', 'debit', '1000');
    await post(m, '20', 'payables', 'credit', '1000');
    await post(m, last, 'payables', 'debit', '800');
    await post(m, last, 'cash', 'credit', '800');
  }
}

/**
 * TB — a cumulative trial balance for each month (natural sign: debit positive).
 *
 *   receivables  7,000 / 8,000 / 9,000     payables  −3,000 / −3,500 / −4,000
 *   inventory    2,000 each month          loan     −10,000 each month
 *   revenue YTD  −6,000 / −12,000 / −18,000 (cumulative: the engine differences it)
 *   cost_of_sales YTD 2,000 / 4,000 / 6,000
 *   July carries NO payables row: a trial balance that lists no balance for an account states zero.
 *
 *   receivables  7,000.00 / 8,000.00 / 9,000.00   (balance basis, no aging)
 *   payables     3,000.00 / 0.00 / 4,000.00
 */
async function trialBalanceOrg(org: string): Promise<void> {
  const lines: Record<string, readonly (string | null)[]> = {
    receivables: ['7000', '8000', '9000'],
    payables: ['-3000', null, '-4000'],
    inventory: ['2000', '2000', '2000'],
    loan: ['-10000', '-10000', '-10000'],
    revenue: ['-6000', '-12000', '-18000'],
    cost_of_sales: ['2000', '4000', '6000'],
  };
  for (const [m, month] of MONTHS.entries()) {
    const doc = await document(org, `tb-${month.key}`, 'trial_balance');
    const b = await batch(org, doc, { importType: 'trial_balance', target: 'period_balances', start: month.start, end: month.end, balanceBasis: 'cumulative' });
    for (const [category, values] of Object.entries(lines)) {
      const value = values[m];
      if (value === null || value === undefined) continue;
      const row = await importRow(org, b);
      const id = await seedPeriodBalance(org, {
        periodStart: month.start, accountId: await account(org, category), closing: value, kind: 'trial_balance',
        basis: 'cumulative', documentId: doc, batchId: b, importRowId: row, sourceRef: `tb${rowNumber}`,
      });
      await accepted(org, 'period_balances', id, b);
    }
  }
}

export async function seedAdr120Orgs(tag: string): Promise<Record<FixtureKey, string>> {
  const owners = [await createAuthUser(`owner-a@${tag}.adr120.itest`), await createAuthUser(`owner-b@${tag}.adr120.itest`),
    await createAuthUser(`owner-c@${tag}.adr120.itest`), await createAuthUser(`owner-d@${tag}.adr120.itest`)];
  let n = 0;
  const create = async (name: string): Promise<string> => {
    // Two organisations per owner, as `create_organization`'s per-person throttle required.
    const owner = owners[Math.floor(n++ / 2)]!;
    return (await seedOrg({ name: `ADR120 ${name} ${tag}`, ownerId: owner })).orgId;
  };
  const orgs = {
    BANK: await create('Bank'), INVBANK: await create('InvBank'), INVONLY: await create('InvOnly'),
    LEDGER: await create('Ledger'), TB: await create('TB'), EMPTY: await create('Empty'),
    HISTORY: await create('History'),
  };

  /*
   * BANK — opening 20,000.00 on 05-31; each month +2,000.00 in, −5,000.00 out (net −3,000.00).
   *   opening/closing  Jun 20,000 → 17,000 · Jul 17,000 → 14,000 · Aug 14,000 → 11,000
   *   runway Aug = 11,000 / mean burn 3,000 = 3.7 months (three months of history)
   */
  await bankStatements(orgs.BANK, '20000', [['2000', '-5000'], ['2000', '-5000'], ['2000', '-5000']]);

  // INVBANK — the invoice set plus a statement: opening 5,000; Jun +800 −600, Jul +1,200 −700, Aug −900.
  //   closing Jun 5,200 · Jul 5,700 · Aug 4,800
  //   working_capital Aug = 4,800 + 4,400 − 900 = 8,300.00 (no trial balance: inventory etc. unknown)
  await invoiceSet(orgs.INVBANK, true);
  await bankStatements(orgs.INVBANK, '5000', [['800', '-600'], ['1200', '-700'], ['-900']]);

  await invoiceSet(orgs.INVONLY, false);

  // LEDGER — plus a statement so cash is known: opening 10,000; Jun +3,000 −800, Jul +2,500 −800, Aug +6,000 −800.
  await ledgerOrg(orgs.LEDGER);
  await bankStatements(orgs.LEDGER, '10000', [['3000', '-800'], ['2500', '-800'], ['6000', '-800']]);

  // TB — plus a statement: opening 3,000; Jun +500, Jul −200, Aug +100.  closing 3,500 / 3,300 / 3,400
  //   working_capital Aug = 3,400 + 9,000 + 2,000 (inventory) − 4,000 = 10,400.00; loan is not a WC term
  await trialBalanceOrg(orgs.TB);
  await bankStatements(orgs.TB, '3000', [['500'], ['-200'], ['100']]);

  /*
   * HISTORY — a GL for March–August (sales 1,000 a month through the bank) and statements only from
   * June, whose first statement prints an opening balance of 8,000.00; nothing is typed on the account.
   *   Mar–May: no statement and no opening → cash unknown (NULL no_opening_cash), never 0
   *   Jun: opens at the statement's 8,000.00 (verified) → +1,500 → 9,500.00; Jul → 10,000.00; Aug → 10,300.00
   */
  await historyOrg(orgs.HISTORY);
  await bankStatements(orgs.HISTORY, null, [['1500'], ['500'], ['300']], '8000');

  return orgs;
}

async function historyOrg(org: string): Promise<void> {
  const months = [
    { key: 'mar', start: '2026-03-01', end: '2026-03-31' }, { key: 'apr', start: '2026-04-01', end: '2026-04-30' },
    { key: 'may', start: '2026-05-01', end: '2026-05-31' }, ...MONTHS,
  ];
  for (const month of months) {
    const doc = await document(org, `hgl-${month.key}`, 'general_ledger');
    const b = await batch(org, doc, { importType: 'general_ledger', target: 'ledger_entries', start: month.start, end: month.end });
    for (const [category, direction] of [['cash', 'debit'], ['revenue', 'credit']] as const) {
      const row = await importRow(org, b);
      const id = await seedLedgerEntry(org, {
        date: month.end, accountId: await account(org, category), direction, amount: '1000',
        documentId: doc, batchId: b, importRowId: row, sourceRef: `h${rowNumber}`,
      });
      await accepted(org, 'ledger_entries', id, b);
    }
  }
}

/**
 * Drains the queue until ONE job is terminal and returns its status. The queue is shared by every
 * suite on the emulators, so another file's worker may hold this job `running` for a while: wait for
 * it (up to `ms`) rather than give up after a fixed number of drains, as `drainUntilFinished` does.
 */
export async function untilFinished(jobId: string, ms = 600_000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = String((await fs().collection('jobs').doc(jobId).get()).get('status') ?? '');
    if (s === 'succeeded' || s === 'failed' || s === 'dead' || s === 'cancelled' || s === '' || Date.now() > deadline) return s;
    // Another suite's job this drain happens to claim may be deleted under it by that suite's
    // teardown; that is not this job's outcome, which is read from its own document above.
    const claimed = await drainJobs(3).then((r) => r.claimed, () => 1);
    if (claimed === 0) await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** One real calculation, then the alert pass it enqueues — both through the queue. */
export async function calculateAndAlert(org: string): Promise<void> {
  const jobId = await seedJob(org, 'calculation.run', { trigger: 'recalc_manual', as_of: AS_OF }, 3);
  expect(await untilFinished(jobId), `the calculation for ${org} must succeed`).toBe('succeeded');
  const alertJob = (await jobsOf(org, { jobType: 'alerts.evaluate' }))[0];
  if (alertJob) expect(await untilFinished(String(alertJob.id))).toBe('succeeded');
}

/** The fiscal period starting `start`: its id is derived, so no read is needed (FIRESTORE_DATA_MODEL.md §3). */
export function periodId(org: string, start: string): string {
  return derivedPeriodId(org, start);
}

export interface Headline {
  readonly value: string | null;
  readonly basis: string;
  readonly missing: readonly string[];
  readonly warnings: readonly string[];
  readonly snapshotId: string;
}

/** The current snapshots of `key` in the period starting `start` (every dimension, or one type). */
export async function currentSnapshots(
  org: string, start: string, key: string, dimensionType: string | null = 'none',
): Promise<Array<Record<string, unknown>>> {
  let q: FirebaseFirestore.Query = orgCollection(fs(), org, 'metric_current')
    .where('period_id', '==', derivedPeriodId(org, start)).where('metric_key', '==', key);
  if (dimensionType !== null) q = q.where('dimension_type', '==', dimensionType);
  const pointers = await q.get();
  if (pointers.empty) return [];
  const snaps = await fs().getAll(...pointers.docs.map((p) => orgRow(fs(), org, 'metric_snapshots', String(p.get('snapshot_id')))));
  return snaps.filter((s) => s.exists).map((s) => s.data()!);
}

/** The current headline snapshot of `key` in the period starting `start`, or undefined when none was written. */
export async function headline(org: string, start: string, key: string): Promise<Headline | undefined> {
  const s = (await currentSnapshots(org, start, key))[0];
  if (!s) return undefined;
  const dq = (s.data_quality ?? {}) as { missing?: string[] | null; warnings?: string[] | null };
  return {
    value: metricValueText(s.value), basis: String(s.basis), missing: dq.missing ?? [], warnings: dq.warnings ?? [],
    snapshotId: String(s.id),
  };
}

/** Everything the regression audit compares: headline figures, health breakdowns and alerts, per fixture. */
export async function dumpOrg(org: string): Promise<unknown> {
  const { engineDump } = await import('./engine-dump');
  const full = await engineDump(org);
  const metrics = full.metrics.map((line) => {
    const [period, key, value, , , , missing] = line.split('|');
    return `${period}|${key}|${value}|${missing!.slice(2)}`;
  });
  const alerts = full.alerts.map((line) => line.split('|').slice(0, 5).join('|'));
  return { metrics, health: full.health, alerts };
}
