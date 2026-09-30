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
import { drainJobs } from '@/modules/jobs';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from '../integration/setup';

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

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`).split('\n')[0]!.trim();

function account(org: string, category: string): string {
  return one(`select id from public.accounts where organization_id = '${org}' and standard_category = '${category}'
               order by is_system desc, id limit 1`);
}

function document(org: string, tag: string, kind: string): string {
  return one(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${org}', '${org}/adr120/${tag}.csv', '${tag}.csv', 'text/csv', 10, digest('${org}${tag}', 'sha256'), 'ready', '${kind}') returning id`);
}

function batch(org: string, doc: string, o: {
  importType: string; target: string; start: string; end: string;
  bankAccount?: string; listKind?: 'full' | 'open_items'; balanceBasis?: 'cumulative' | 'movement';
}): string {
  return one(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method,
      period_start, period_end, committed_at, bank_account_id, invoice_list_kind, balance_basis)
    values ('${org}', '${doc}', '${o.importType}', '${o.target}', 'committed', 'csv', '${o.start}', '${o.end}', '${COMMITTED_AT}',
      ${o.bankAccount ? `'${o.bankAccount}'` : 'null'}, ${o.listKind ? `'${o.listKind}'` : 'null'},
      ${o.balanceBasis ? `'${o.balanceBasis}'` : 'null'}) returning id`);
}

let rowNumber = 0;
function importRow(org: string, batchId: string): string {
  rowNumber += 1;
  return one(`insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
    values ('${org}', '${batchId}', ${rowNumber}, 'r${rowNumber}', '{}'::jsonb, '{}'::jsonb, 'committed') returning id`);
}

function accepted(org: string, table: string, id: string, batchId: string): void {
  adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id)
    values ('${org}', '${table}', '${id}', 'accepted', '${batchId}')`);
}

/**
 * A current account with statements for June–August; `moves[m]` are that month's signed amounts.
 * `openingBalance` is typed on the account (dated 05-31); `statementOpening`, when given, is printed
 * on the JUNE statement instead — the first source CD-06 names.
 */
function bankStatements(
  org: string, openingBalance: string | null, moves: readonly (readonly string[])[], statementOpening: string | null = null,
): string {
  const bank = one(`insert into public.bank_accounts (organization_id, name, bank_name, account_type, opening_balance, opening_balance_date, is_active)
    values ('${org}', 'Main', 'Test Bank', 'current', ${openingBalance ?? 'null'}, ${openingBalance === null ? 'null' : `'2026-05-31'`}, true) returning id`);
  MONTHS.forEach((month, m) => {
    const doc = document(org, `bank-${month.key}`, 'bank_statement');
    const b = batch(org, doc, { importType: 'bank_statement', target: 'bank_transactions', start: month.start, end: month.end, bankAccount: bank });
    if (m === 0 && statementOpening !== null) {
      adminSql(`update public.import_batches set statement_opening_balance = ${statementOpening} where id = '${b}'`);
    }
    (moves[m] ?? []).forEach((amount, i) => {
      const row = importRow(org, b);
      const id = one(`insert into public.bank_transactions (organization_id, bank_account_id, transaction_date, amount, currency, description_raw,
          description_normalized, period_id, category_source, record_status, assurance_level, duplicate_reviewed, source_document_id,
          import_batch_id, import_row_id, source_ref, is_transfer, transfer_kind)
        values ('${org}', '${bank}', '${month.start.slice(0, 8)}${String(10 + i).padStart(2, '0')}', ${amount}, 'GBP', 'mv ${m}-${i}', 'mv ${m}-${i}',
          '00000000-0000-0000-0000-000000000000', 'none', 'accepted', 'verified', true, '${doc}', '${b}', '${row}', 'b${m}-${i}', false, 'none') returning id`);
      accepted(org, 'bank_transactions', id, b);
    });
  });
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
function invoiceList(org: string, importType: 'sales_invoices' | 'purchase_invoices', rows: readonly InvoiceSeed[]): void {
  const doc = document(org, importType, 'invoice');
  const b = batch(org, doc, { importType, target: 'invoices', start: '2026-06-01', end: '2026-08-31', listKind: 'full' });
  for (const r of rows) {
    const row = importRow(org, b);
    const id = one(`insert into public.invoices (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id,
        subtotal, tax_amount, total_amount, amount_paid, paid_date, status, record_status, assurance_level,
        source_document_id, import_batch_id, import_row_id, source_ref)
      values ('${org}', '${r.type}', '${r.party}', '${r.number}', '${r.issue}', ${r.due ? `'${r.due}'` : 'null'},
        '00000000-0000-0000-0000-000000000000', ${r.subtotal}, ${r.tax}, ${r.total}, ${r.paid}, ${r.paidDate ? `'${r.paidDate}'` : 'null'},
        '${r.status}', 'accepted', 'verified', '${doc}', '${b}', '${row}', 'inv${rowNumber}') returning id`);
    accepted(org, 'invoices', id, b);
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
function invoiceSet(org: string, withPurchases: boolean): void {
  const acme = one(`insert into public.counterparties (organization_id, name, kind) values ('${org}', 'Acme Ltd', 'customer') returning id`);
  const beta = one(`insert into public.counterparties (organization_id, name, kind) values ('${org}', 'Beta plc', 'customer') returning id`);
  invoiceList(org, 'sales_invoices', [
    { type: 'sales', party: acme, number: 'S1', issue: '2026-06-05', due: '2026-07-05', subtotal: '1000', tax: '200', total: '1200', paid: '1200', paidDate: '2026-07-01', status: 'paid' },
    { type: 'sales', party: beta, number: 'S2', issue: '2026-07-10', due: '2026-08-09', subtotal: '2000', tax: '400', total: '2400', paid: '0', paidDate: null, status: 'open' },
    { type: 'sales', party: acme, number: 'S3', issue: '2026-08-03', due: '2026-09-02', subtotal: '3000', tax: '600', total: '3600', paid: '1000', paidDate: null, status: 'partially_paid' },
    { type: 'sales_credit_note', party: acme, number: 'C1', issue: '2026-08-20', due: '2026-08-20', subtotal: '500', tax: '100', total: '600', paid: '0', paidDate: null, status: 'open' },
    { type: 'sales', party: beta, number: 'V1', issue: '2026-08-12', due: '2026-08-12', subtotal: '9999', tax: '0', total: '9999', paid: '0', paidDate: null, status: 'void' },
  ]);
  if (withPurchases) {
    const parts = one(`insert into public.counterparties (organization_id, name, kind, default_expense_category)
      values ('${org}', 'Parts Co', 'supplier', 'cost_of_sales') returning id`);
    invoiceList(org, 'purchase_invoices', [
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
function ledgerOrg(org: string): void {
  const docs = MONTHS.map((month) => {
    const doc = document(org, `gl-${month.key}`, 'general_ledger');
    return { doc, batch: batch(org, doc, { importType: 'general_ledger', target: 'ledger_entries', start: month.start, end: month.end }) };
  });
  const post = (m: number, day: string, category: string, direction: 'debit' | 'credit', amount: string, opening = false) => {
    const { doc, batch: b } = docs[m]!;
    const row = importRow(org, b);
    const id = one(`insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status,
        source_document_id, import_batch_id, import_row_id, source_ref, is_opening_balance)
      values ('${org}', '${MONTHS[m]!.start.slice(0, 8)}${day}', '${account(org, category)}', '${direction}', ${amount},
        '00000000-0000-0000-0000-000000000000', 'accepted', '${doc}', '${b}', '${row}', 'gl${rowNumber}', ${opening}) returning id`);
    accepted(org, 'ledger_entries', id, b);
  };
  post(0, '01', 'receivables', 'debit', '5000', true);
  post(0, '01', 'payables', 'credit', '2000', true);
  post(0, '01', 'equity', 'credit', '3000', true);
  const sales = ['4000', '3000', '2000'];
  const receipts = ['3000', '2500', '6000'];
  MONTHS.forEach((month, m) => {
    const last = month.end.slice(8, 10);
    post(m, '05', 'receivables', 'debit', sales[m]!);
    post(m, '05', 'revenue', 'credit', sales[m]!);
    post(m, '15', 'cash', 'debit', receipts[m]!);
    post(m, '15', 'receivables', 'credit', receipts[m]!);
    post(m, '20', 'cost_of_sales', 'debit', '1000');
    post(m, '20', 'payables', 'credit', '1000');
    post(m, last, 'payables', 'debit', '800');
    post(m, last, 'cash', 'credit', '800');
  });
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
function trialBalanceOrg(org: string): void {
  const lines: Record<string, readonly (string | null)[]> = {
    receivables: ['7000', '8000', '9000'],
    payables: ['-3000', null, '-4000'],
    inventory: ['2000', '2000', '2000'],
    loan: ['-10000', '-10000', '-10000'],
    revenue: ['-6000', '-12000', '-18000'],
    cost_of_sales: ['2000', '4000', '6000'],
  };
  MONTHS.forEach((month, m) => {
    const doc = document(org, `tb-${month.key}`, 'trial_balance');
    const b = batch(org, doc, { importType: 'trial_balance', target: 'period_balances', start: month.start, end: month.end, balanceBasis: 'cumulative' });
    for (const [category, values] of Object.entries(lines)) {
      const value = values[m];
      if (value === null || value === undefined) continue;
      const row = importRow(org, b);
      const id = one(`insert into public.period_balances (organization_id, period_start, period_id, account_id, closing_balance,
          balance_kind, balance_basis, source_document_id, import_batch_id, import_row_id, source_ref, record_status)
        values ('${org}', '${month.start}', '00000000-0000-0000-0000-000000000000', '${account(org, category)}', ${value},
          'trial_balance', 'cumulative', '${doc}', '${b}', '${row}', 'tb${rowNumber}', 'accepted') returning id`);
      accepted(org, 'period_balances', id, b);
    }
  });
}

export async function seedAdr120Orgs(tag: string): Promise<Record<FixtureKey, string>> {
  const owners = [createAuthUser(`owner-a@${tag}.adr120.itest`), createAuthUser(`owner-b@${tag}.adr120.itest`),
    createAuthUser(`owner-c@${tag}.adr120.itest`), createAuthUser(`owner-d@${tag}.adr120.itest`)];
  let n = 0;
  const create = async (name: string): Promise<string> => {
    // `create_organization` is throttled per person, so the six organisations take three owners.
    const owner = owners[Math.floor(n++ / 2)]!;
    const r = await clientFor(owner).schema('api').rpc('create_organization', { p_name: `ADR120 ${name} ${tag}` });
    if (r.error) throw new Error(r.error.message);
    return r.data as unknown as string;
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
  bankStatements(orgs.BANK, '20000', [['2000', '-5000'], ['2000', '-5000'], ['2000', '-5000']]);

  // INVBANK — the invoice set plus a statement: opening 5,000; Jun +800 −600, Jul +1,200 −700, Aug −900.
  //   closing Jun 5,200 · Jul 5,700 · Aug 4,800
  //   working_capital Aug = 4,800 + 4,400 − 900 = 8,300.00 (no trial balance: inventory etc. unknown)
  invoiceSet(orgs.INVBANK, true);
  bankStatements(orgs.INVBANK, '5000', [['800', '-600'], ['1200', '-700'], ['-900']]);

  invoiceSet(orgs.INVONLY, false);

  // LEDGER — plus a statement so cash is known: opening 10,000; Jun +3,000 −800, Jul +2,500 −800, Aug +6,000 −800.
  ledgerOrg(orgs.LEDGER);
  bankStatements(orgs.LEDGER, '10000', [['3000', '-800'], ['2500', '-800'], ['6000', '-800']]);

  // TB — plus a statement: opening 3,000; Jun +500, Jul −200, Aug +100.  closing 3,500 / 3,300 / 3,400
  //   working_capital Aug = 3,400 + 9,000 + 2,000 (inventory) − 4,000 = 10,400.00; loan is not a WC term
  trialBalanceOrg(orgs.TB);
  bankStatements(orgs.TB, '3000', [['500'], ['-200'], ['100']]);

  /*
   * HISTORY — a GL for March–August (sales 1,000 a month through the bank) and statements only from
   * June, whose first statement prints an opening balance of 8,000.00; nothing is typed on the account.
   *   Mar–May: no statement and no opening → cash unknown (NULL no_opening_cash), never 0
   *   Jun: opens at the statement's 8,000.00 (verified) → +1,500 → 9,500.00; Jul → 10,000.00; Aug → 10,300.00
   */
  historyOrg(orgs.HISTORY);
  bankStatements(orgs.HISTORY, null, [['1500'], ['500'], ['300']], '8000');

  return orgs;
}

function historyOrg(org: string): void {
  const months = [
    { key: 'mar', start: '2026-03-01', end: '2026-03-31' }, { key: 'apr', start: '2026-04-01', end: '2026-04-30' },
    { key: 'may', start: '2026-05-01', end: '2026-05-31' }, ...MONTHS,
  ];
  for (const month of months) {
    const doc = document(org, `hgl-${month.key}`, 'general_ledger');
    const b = batch(org, doc, { importType: 'general_ledger', target: 'ledger_entries', start: month.start, end: month.end });
    for (const [category, direction] of [['cash', 'debit'], ['revenue', 'credit']] as const) {
      const row = importRow(org, b);
      const id = one(`insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status,
          source_document_id, import_batch_id, import_row_id, source_ref)
        values ('${org}', '${month.end}', '${account(org, category)}', '${direction}', 1000,
          '00000000-0000-0000-0000-000000000000', 'accepted', '${doc}', '${b}', '${row}', 'h${rowNumber}') returning id`);
      accepted(org, 'ledger_entries', id, b);
    }
  }
}

/** One real calculation, then the alert pass it enqueues — both through the queue. */
export async function calculateAndAlert(org: string): Promise<void> {
  const jobId = one(`insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${org}', 'calculation.run', '{"trigger":"recalc_manual","as_of":"${AS_OF}"}'::jsonb, 3) returning id`);
  expect(await drainUntilFinished(drainJobs, jobId), `the calculation for ${org} must succeed`).toBe('succeeded');
  const alertJob = one(`select id from public.jobs where organization_id = '${org}' and job_type = 'alerts.evaluate'
    order by created_at desc limit 1`);
  if (alertJob !== '') expect(await drainUntilFinished(drainJobs, alertJob)).toBe('succeeded');
}

export function periodId(org: string, start: string): string {
  return one(`select id from public.fiscal_periods where organization_id = '${org}' and period_start = '${start}'`);
}

export interface Headline {
  readonly value: string | null;
  readonly basis: string;
  readonly missing: readonly string[];
  readonly warnings: readonly string[];
  readonly snapshotId: string;
}

/** The current headline snapshot of `key` in the period starting `start`, or undefined when none was written. */
export function headline(org: string, start: string, key: string): Headline | undefined {
  const raw = one(`select json_build_object('value', s.value::text, 'basis', s.basis, 'missing', s.data_quality->'missing',
      'warnings', s.data_quality->'warnings', 'snapshotId', s.id)::text
    from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
    join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
    where c.organization_id = '${org}' and p.period_start = '${start}' and c.metric_key = '${key}' and c.dimension_type = 'none'`);
  if (raw === '') return undefined;
  const parsed = JSON.parse(raw) as { value: string | null; basis: string; missing: string[] | null; warnings: string[] | null; snapshotId: string };
  return { ...parsed, missing: parsed.missing ?? [], warnings: parsed.warnings ?? [] };
}

/** Everything the regression audit compares: headline figures, health breakdowns and alerts, per fixture. */
export function dumpOrg(org: string): unknown {
  const metrics = adminSql(`select p.period_start || '|' || c.metric_key || '|' || coalesce(s.value::text, 'NULL') || '|' ||
      coalesce((s.data_quality->'missing')::text, '[]')
    from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
    join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
    where c.organization_id = '${org}' and c.dimension_type = 'none' order by 1`).split('\n').filter(Boolean).map((l) => l.trim());
  const health = adminSql(`select json_build_object('period', p.period_start, 'score', h.score, 'used', h.dimensions_used,
      'dimensions', (select json_agg(json_build_object('key', d->>'key', 'score', d->'score', 'included', d->'included',
        'exclusion', d->'exclusion_reason', 'rules', (select json_agg(json_build_object('rule', r->>'rule', 'result', r->>'result', 'points', r->'points'))
          from jsonb_array_elements(d->'rules') r))) from jsonb_array_elements(h.breakdown) d))::text
    from public.health_current hc join public.health_scores h on h.id = hc.health_score_id and h.organization_id = hc.organization_id
    join public.fiscal_periods p on p.id = hc.period_id and p.organization_id = hc.organization_id
    where hc.organization_id = '${org}' order by p.period_start`).split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown);
  const alerts = adminSql(`select a.rule_key || '|' || coalesce(a.subject_type::text, '-') || '|' || a.status || '|' || a.severity || '|' || p.period_start
    from public.alerts a join public.fiscal_periods p on p.id = a.period_id and p.organization_id = a.organization_id
    where a.organization_id = '${org}' order by 1`).split('\n').filter(Boolean).map((l) => l.trim());
  return { metrics, health, alerts };
}
