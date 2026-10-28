/**
 * The eleven adversarial organisations of the ADR-120 independent audit (docs/ADR-120_INDEPENDENT_AUDIT.md),
 * kept as permanent fixtures for ADR-123 — each reproduces one audit finding. Raw accepted records under
 * committed batches (the shape a real commit leaves); every figure comes only from the real
 * `calculation.run` job through the queue. Commit times are FIXED (`COMMITTED_AT`), never `now()`.
 */
import { Decimal } from '@/core/money/decimal';
import { newId, nowIso, orgCollection, orgRow } from '@/db/schema';
import { createAuthUser, fs } from '../integration/setup';
import { COMMITTED_AT } from './adr120-orgs';
import {
  periodFor, seedAccepted, seedBankAccount, seedBankTransaction, seedBatch, seedCounterparty, seedDocument,
  seedImportRow, seedInvoice, seedLedgerEntry, seedOrg, seedPeriodBalance,
} from './seed';

/**
 * The whole PostgreSQL fixture became Firestore writes (FIRESTORE_DATA_MODEL.md §9): every helper
 * below is now `async`, writes the same rows the `do $$ … $$` blocks inserted (through `./seed`, which
 * stores what the old defaults and triggers filled in), and returns the same ids.
 */

const accountCache = new Map<string, string>();

/** One of the organisation's accounts of a category: the system one first, then the lowest id. */
export async function acct(org: string, category: string): Promise<string> {
  const key = `${org}:${category}`;
  const hit = accountCache.get(key);
  if (hit) return hit;
  const snap = await orgCollection(fs(), org, 'accounts').where('standard_category', '==', category).get();
  const rows = snap.docs.map((d) => d.data()).sort((a, b) =>
    Number(b.is_system === true) - Number(a.is_system === true) || String(a.id).localeCompare(String(b.id)));
  const id = String(rows[0]?.id ?? '');
  if (id) accountCache.set(key, id);
  return id;
}

/** A batch's `batch_issues`, set after the fact (the fixtures' `update public.import_batches`). */
export async function setBatchIssues(org: string, batchId: string, issues: unknown[]): Promise<void> {
  await orgRow(fs(), org, 'import_batches', batchId).update({ batch_issues: issues, updated_at: nowIso() });
}

/** The reviewer's answer stored on a batch, as `confirmations` holds it. */
export const confirmation = (code: string, value: Record<string, unknown>): Record<string, unknown> =>
  ({ [code]: { by: null, at: nowIso(), value } });

export interface Move { readonly date: string; readonly amount: string }

/** One committed statement batch and its transactions. Returns the batch id. */
export async function statement(org: string, bank: string, o: {
  start: string; end: string; committedAt?: string; opening?: string | null; closing?: string | null; moves: readonly Move[]; tag: string;
}): Promise<string> {
  const documentId = await seedDocument(org, `${o.tag}.csv`, 'bank_statement');
  const b = await seedBatch(org, {
    importType: 'bank_statement', target: 'bank_transactions', start: o.start, end: o.end,
    committedAt: o.committedAt ?? COMMITTED_AT, bankAccountId: bank, statementOpening: o.opening ?? null,
    statementClosing: o.closing ?? null, documentId,
  });
  let n = 0;
  for (const m of o.moves) {
    n += 1;
    const row = await seedImportRow(org, b);
    const id = await seedBankTransaction(org, {
      bankAccountId: bank, date: m.date, amount: m.amount, description: `mv ${n} ${b}`,
      documentId, batchId: b, importRowId: row, sourceRef: `b${n}`,
    });
    await seedAccepted(org, 'bank_transactions', id, b);
  }
  return b;
}

export async function bankAccount(org: string, opening: string | null, openingDate: string | null, name = 'Main'): Promise<string> {
  return seedBankAccount(org, { name, accountType: 'current', openingBalance: opening, openingBalanceDate: openingDate });
}

export async function counterparty(org: string, name: string, kind: 'customer' | 'supplier', category: string | null = null): Promise<string> {
  return seedCounterparty(org, { name, kind, defaultExpenseCategory: category });
}

export interface Inv {
  readonly type: 'sales' | 'sales_credit_note' | 'purchase' | 'purchase_credit_note';
  readonly party: string; readonly number: string; readonly issue: string; readonly due: string | null;
  readonly subtotal: string; readonly tax: string; readonly total: string; readonly paid: string;
  readonly paidDate: string | null; readonly status: 'open' | 'partially_paid' | 'paid' | 'void';
}

export async function invoiceBatch(org: string, o: {
  importType: 'sales_invoices' | 'purchase_invoices'; start: string; end: string; listKind: 'full' | 'open_items';
  committedAt?: string; invoices: readonly Inv[]; tag: string;
  /** R-2: confirmed to hold every invoice unpaid at its start (default: a complete export). */
  openingConfirmed?: boolean;
}): Promise<string> {
  const documentId = await seedDocument(org, `${o.tag}.csv`, 'invoice');
  const b = await seedBatch(org, {
    importType: o.importType, target: 'invoices', start: o.start, end: o.end, committedAt: o.committedAt ?? COMMITTED_AT,
    listKind: o.listKind, documentId,
    confirmations: o.openingConfirmed === false ? {} : confirmation('IMP-INV-013', { opening: 'complete' }),
  });
  let n = 0;
  for (const r of o.invoices) {
    n += 1;
    const row = await seedImportRow(org, b);
    const id = await seedInvoice(org, {
      type: r.type, counterpartyId: r.party, number: r.number, issue: r.issue, due: r.due, subtotal: r.subtotal,
      tax: r.tax, total: r.total, paid: r.paid, paidDate: r.paidDate, status: r.status,
      documentId, batchId: b, importRowId: row, sourceRef: `i${n}${b}`,
    });
    await seedAccepted(org, 'invoices', id, b);
  }
  return b;
}

export interface GlLine { readonly date: string; readonly category: string; readonly direction: 'debit' | 'credit'; readonly amount: string; readonly opening?: boolean }

export async function glBatch(org: string, o: { start: string; end: string; lines: readonly GlLine[]; tag: string }): Promise<string> {
  const documentId = await seedDocument(org, `${o.tag}.csv`, 'general_ledger');
  const b = await seedBatch(org, {
    importType: 'general_ledger', target: 'ledger_entries', start: o.start, end: o.end, committedAt: COMMITTED_AT, documentId,
  });
  let n = 0;
  for (const l of o.lines) {
    n += 1;
    const row = await seedImportRow(org, b);
    const id = await seedLedgerEntry(org, {
      date: l.date, accountId: await acct(org, l.category), direction: l.direction, amount: l.amount,
      isOpeningBalance: l.opening === true, documentId, batchId: b, importRowId: row, sourceRef: `g${n}${b}`,
    });
    await seedAccepted(org, 'ledger_entries', id, b);
  }
  return b;
}

export async function balanceBatch(org: string, o: {
  importType: 'trial_balance' | 'balance_sheet'; basis: 'cumulative' | 'movement'; start: string; end: string;
  rows: ReadonlyArray<readonly [string, string]>; tag: string;
  /** N-1: record the reviewer's IMP-TB-016 attestation that the report lists every account. */
  complete?: boolean;
  /** How the batch was read (default csv); `pdf_claude` stands for an AI-read report. */
  extraction?: 'csv' | 'pdf_claude';
}): Promise<string> {
  const documentId = await seedDocument(org, `${o.tag}.csv`, o.importType);
  const b = await seedBatch(org, {
    importType: o.importType, target: 'period_balances', start: o.start, end: o.end, committedAt: COMMITTED_AT,
    balanceBasis: o.basis, extractionMethod: o.extraction ?? 'csv', documentId,
    confirmations: o.complete === true ? confirmation('IMP-TB-016', { report_complete: 'complete' }) : {},
  });
  let n = 0;
  for (const [category, value] of o.rows) {
    n += 1;
    const row = await seedImportRow(org, b);
    const id = await seedPeriodBalance(org, {
      periodStart: o.start, accountId: await acct(org, category), closing: value, kind: o.importType, basis: o.basis,
      documentId, batchId: b, importRowId: row, sourceRef: `p${n}${b}`,
    });
    await seedAccepted(org, 'period_balances', id, b);
  }
  return b;
}

/** Months helper: YYYY-MM → { start, end }. */
export function month(ym: string): { start: string; end: string } {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${ym}-01`, end: `${ym}-${String(last).padStart(2, '0')}` };
}
export function monthsFrom(ym: string, count: number): string[] {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const t = y * 12 + (m - 1) + i;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  });
}

export type AuditKey =
  | 'GAP' | 'MIDSTART' | 'LEDGER2' | 'TBBS' | 'MOVTB' | 'CURRENT' | 'CREDITHEAVY' | 'PARTIALPD' | 'LONG' | 'BIGINV' | 'BSREV';

/** Seeds the adversarial organisations. */
export async function seedAuditOrgs(tag: string, keys: readonly AuditKey[]): Promise<Partial<Record<AuditKey, string>>> {
  const out: Partial<Record<AuditKey, string>> = {};
  let n = 0;
  let owner = '';
  for (const key of keys) {
    if (n % 2 === 0) owner = await createAuthUser(`aud-${n}@${tag}.adr123.itest`);
    n += 1;
    const { orgId: org } = await seedOrg({ name: `ADR123 ${key} ${tag}`, ownerId: owner });
    out[key] = org;
    await seedOne(key, org);
  }
  return out;
}

async function seedOne(key: AuditKey, org: string): Promise<void> {
  switch (key) {
    case 'GAP': {
      // Statements for June and August; JULY'S STATEMENT IS MISSING. August's statement prints its own
      // opening of 4,000.00 (so the truth is on file). Nothing typed on the account.
      // June: printed opening 10,000, −1,000 → 9,000. Truth: July −5,000 (unknown to MOTION) → Aug open 4,000; Aug −500 → 3,500.
      const bank = await bankAccount(org, null, null);
      await statement(org, bank, { ...month('2026-06'), opening: '10000', moves: [{ date: '2026-06-10', amount: '-1000' }], tag: 'gap-jun' });
      await statement(org, bank, { ...month('2026-08'), opening: '4000', closing: '3500', moves: [{ date: '2026-08-10', amount: '-500' }], tag: 'gap-aug' });
      break;
    }
    case 'MIDSTART': {
      // S1 1–20 June (printed opening 10,000; −4,000 on 06-10); S2 21 June–31 July (−1,000 on 06-25, +500 on 07-10);
      // S3 August (+100). Truth: 1 July = 5,000 → July close 5,500 → August 5,600.
      const bank = await bankAccount(org, null, null);
      await statement(org, bank, { start: '2026-06-01', end: '2026-06-20', opening: '10000', moves: [{ date: '2026-06-10', amount: '-4000' }], tag: 'ms-s1' });
      await statement(org, bank, { start: '2026-06-21', end: '2026-07-31', opening: '6000', moves: [{ date: '2026-06-25', amount: '-1000' }, { date: '2026-07-10', amount: '500' }], tag: 'ms-s2' });
      await statement(org, bank, { ...month('2026-08'), opening: '5500', moves: [{ date: '2026-08-10', amount: '100' }], tag: 'ms-s3' });
      break;
    }
    case 'LEDGER2': {
      // Two annual GL exports, EACH with its own opening journal (IMP-GL-011 at fiscal-year start / export start).
      // Export A (June): opening Dr receivables 5,000 / Cr equity 5,000; June sale Dr recv 1,000 / Cr revenue 1,000.
      // Export B (July–Aug): opening (restated at 1 July) Dr receivables 6,000 / Cr equity 6,000;
      //   July sale Dr recv 1,000 / Cr revenue; August receipt Dr cash 2,000 / Cr recv 2,000.
      // Truth: June 6,000 · July 7,000 · August 5,000.
      await glBatch(org, { ...month('2026-06'), tag: 'l2-a', lines: [
        { date: '2026-06-01', category: 'receivables', direction: 'debit', amount: '5000', opening: true },
        { date: '2026-06-01', category: 'equity', direction: 'credit', amount: '5000', opening: true },
        { date: '2026-06-05', category: 'receivables', direction: 'debit', amount: '1000' },
        { date: '2026-06-05', category: 'revenue', direction: 'credit', amount: '1000' },
      ] });
      await glBatch(org, { start: '2026-07-01', end: '2026-08-31', tag: 'l2-b', lines: [
        { date: '2026-07-01', category: 'receivables', direction: 'debit', amount: '6000', opening: true },
        { date: '2026-07-01', category: 'equity', direction: 'credit', amount: '6000', opening: true },
        { date: '2026-07-05', category: 'receivables', direction: 'debit', amount: '1000' },
        { date: '2026-07-05', category: 'revenue', direction: 'credit', amount: '1000' },
        { date: '2026-08-15', category: 'cash', direction: 'debit', amount: '2000' },
        { date: '2026-08-15', category: 'receivables', direction: 'credit', amount: '2000' },
      ] });
      break;
    }
    case 'TBBS': {
      // A cumulative trial balance AND a cumulative balance sheet for August, both listing receivables 9,000.
      await balanceBatch(org, { importType: 'trial_balance', basis: 'cumulative', ...month('2026-08'), tag: 'tbbs-tb',
        rows: [['receivables', '9000'], ['payables', '-4000'], ['revenue', '-5000'], ['cost_of_sales', '2000']] });
      await balanceBatch(org, { importType: 'balance_sheet', basis: 'cumulative', ...month('2026-08'), tag: 'tbbs-bs',
        rows: [['receivables', '9000'], ['payables', '-4000']] });
      break;
    }
    case 'MOVTB': {
      // A MOVEMENT-basis trial balance and a CUMULATIVE balance sheet for August. The balance sheet states 9,000.
      await balanceBatch(org, { importType: 'trial_balance', basis: 'movement', ...month('2026-08'), tag: 'mov-tb',
        rows: [['receivables', '1000'], ['revenue', '-1000']] });
      await balanceBatch(org, { importType: 'balance_sheet', basis: 'cumulative', ...month('2026-08'), tag: 'mov-bs',
        rows: [['receivables', '9000'], ['payables', '-4000']] });
      break;
    }
    case 'CURRENT': {
      // Realistic commit timing: a sales list committed 2026-09-10 (before the run's as-of 2026-09-15),
      // declared 1 June – 10 September (min/max dates of the file).
      const c = await counterparty(org, 'Cur Ltd', 'customer');
      await invoiceBatch(org, { importType: 'sales_invoices', start: '2026-06-01', end: '2026-09-10', listKind: 'full', committedAt: '2026-09-10T10:00:00Z', tag: 'cur',
        invoices: [
          { type: 'sales', party: c, number: 'C-1', issue: '2026-07-01', due: '2026-07-31', subtotal: '1000', tax: '0', total: '1000', paid: '0', paidDate: null, status: 'open' },
          { type: 'sales', party: c, number: 'C-2', issue: '2026-09-02', due: '2026-10-02', subtotal: '500', tax: '0', total: '500', paid: '0', paidDate: null, status: 'open' },
        ] });
      break;
    }
    case 'CREDITHEAVY': {
      const c = await counterparty(org, 'Cred Ltd', 'customer');
      await invoiceBatch(org, { importType: 'sales_invoices', ...{ start: '2026-06-01', end: '2026-08-31' }, listKind: 'full', tag: 'ch', invoices: [
        { type: 'sales', party: c, number: 'H-1', issue: '2026-06-05', due: '2026-07-05', subtotal: '1000', tax: '0', total: '1000', paid: '0', paidDate: null, status: 'open' },
        { type: 'sales', party: c, number: 'H-2', issue: '2026-07-05', due: '2026-08-05', subtotal: '800', tax: '0', total: '800', paid: '0', paidDate: null, status: 'open' },
        { type: 'sales_credit_note', party: c, number: 'HC-1', issue: '2026-08-10', due: '2026-08-10', subtotal: '2500', tax: '0', total: '2500', paid: '0', paidDate: null, status: 'open' },
      ] });
      break;
    }
    case 'PARTIALPD': {
      // An invoice part-paid with the payment's date recorded (paid_date set, balance still due).
      // PD-1: total 1,000, 400 paid on 07-15, due 07-10 → July-end receivables 600, overdue 600.
      // PD-2: total 500 paid EXACTLY on 07-31 (the as-of date) → 0 at July end.
      const c = await counterparty(org, 'Part Ltd', 'customer');
      await invoiceBatch(org, { importType: 'sales_invoices', start: '2026-06-01', end: '2026-08-31', listKind: 'full', tag: 'pd', invoices: [
        { type: 'sales', party: c, number: 'PD-1', issue: '2026-06-20', due: '2026-07-10', subtotal: '1000', tax: '0', total: '1000', paid: '400', paidDate: '2026-07-15', status: 'partially_paid' },
        { type: 'sales', party: c, number: 'PD-2', issue: '2026-07-01', due: '2026-07-20', subtotal: '500', tax: '0', total: '500', paid: '500', paidDate: '2026-07-31', status: 'paid' },
      ] });
      break;
    }
    case 'LONG': {
      // 15 months (June 2025 – August 2026) of statements + sales invoices: crosses a 12-period chunk boundary.
      // Opening 50,000 typed at 2025-05-31; each month +3,000 in, −4,000 out. Sales: one invoice per month,
      // 1,200 gross, due in 30 days, paid 45 days after issue (so some overdue at each month end).
      const bank = await bankAccount(org, '50000', '2025-05-31');
      const months = monthsFrom('2025-06', 15);
      for (const ym of months) {
        await statement(org, bank, { ...month(ym), moves: [{ date: `${ym}-05`, amount: '3000' }, { date: `${ym}-20`, amount: '-4000' }], tag: `long-${ym}` });
      }
      const c = await counterparty(org, 'Long Ltd', 'customer');
      const s = await counterparty(org, 'Long Supplies', 'supplier', 'cost_of_sales');
      const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
      await invoiceBatch(org, { importType: 'sales_invoices', start: '2025-06-01', end: '2026-08-31', listKind: 'full', tag: 'long-s', invoices:
        months.map((ym, i) => {
          const issue = `${ym}-10`; const paidDate = addDays(issue, 45); const paid = paidDate <= '2026-09-15';
          return { type: 'sales' as const, party: c, number: `L-${i}`, issue, due: addDays(issue, 30), subtotal: String(1000 + i * 50), tax: String(200 + i * 10),
            total: String(1200 + i * 60), paid: paid ? String(1200 + i * 60) : '0', paidDate: paid ? paidDate : null, status: paid ? 'paid' as const : 'open' as const };
        }) });
      await invoiceBatch(org, { importType: 'purchase_invoices', start: '2025-06-01', end: '2026-08-31', listKind: 'full', tag: 'long-p', invoices:
        months.map((ym, i) => {
          const issue = `${ym}-12`; const paidDate = addDays(issue, 20);
          return { type: 'purchase' as const, party: s, number: `LP-${i}`, issue, due: addDays(issue, 30), subtotal: '500', tax: '100',
            total: '600', paid: '600', paidDate, status: 'paid' as const };
        }) });
      break;
    }
    case 'BSREV': {
      // Monthly cumulative balance sheets (receivables 3,000) March–August, no TB/GL/bank, plus ONE sales
      // list declared for March only, committed 5 April. Revenue after March is unknown (no source).
      for (const ym of monthsFrom('2026-03', 6)) {
        await balanceBatch(org, { importType: 'balance_sheet', basis: 'cumulative', ...month(ym), tag: `bsr-${ym}`,
          rows: [['receivables', '3000'], ['payables', '-1000']] });
      }
      const c = await counterparty(org, 'BsRev Ltd', 'customer');
      await invoiceBatch(org, { importType: 'sales_invoices', ...month('2026-03'), listKind: 'full', committedAt: '2026-04-05T09:00:00Z', tag: 'bsr-s',
        invoices: [{ type: 'sales', party: c, number: 'R-1', issue: '2026-03-10', due: '2026-04-10', subtotal: '3000', tax: '0', total: '3000', paid: '3000', paidDate: '2026-04-08', status: 'paid' }] });
      break;
    }
    case 'BIGINV': {
      // 1,050 open sales invoices, each to its own customer, 10.00 gross, issued 07-01, due 07-15:
      // receivables Aug = 10,500.00, all overdue. Plus a statement so cash is known.
      await bigInvoiceList(org);
      const bank = await bankAccount(org, '1000', '2026-05-31');
      for (const ym of ['2026-06', '2026-07', '2026-08']) await statement(org, bank, { ...month(ym), moves: [{ date: `${ym}-11`, amount: '-10' }], tag: `big-${ym}` });
      break;
    }
  }
}

/** BIGINV's list: written in bulk (4,200 documents), each row exactly what `invoiceBatch` writes. */
async function bigInvoiceList(org: string): Promise<void> {
  const f = fs();
  const documentId = await seedDocument(org, 'big.csv', 'invoice');
  const b = await seedBatch(org, {
    importType: 'sales_invoices', target: 'invoices', start: '2026-06-01', end: '2026-08-31', committedAt: COMMITTED_AT,
    listKind: 'full', documentId, confirmations: confirmation('IMP-INV-013', { opening: 'complete' }),
  });
  const period = await periodFor(org, '2026-07-01');
  const writer = f.bulkWriter();
  const now = nowIso();
  for (let i = 1; i <= 1050; i += 1) {
    const c = newId(); const row = newId(); const inv = newId(); const ev = newId();
    void writer.set(orgRow(f, org, 'counterparties', c), {
      id: c, organization_id: org, name: `Cust ${i}`, normalized_name: `cust ${i}`, kind: 'customer',
      default_expense_category: null, external_ref: null, email: null, notes: null, is_active: true, merged_into_id: null,
      created_at: now, updated_at: now,
    });
    void writer.set(orgRow(f, org, 'import_rows', row), {
      id: row, organization_id: org, batch_id: b, row_number: i, source_ref: `r${i}`, raw_data: {}, mapped_data: {},
      status: 'committed', issues: [], dedupe_hash: null, duplicate_of_table: null, duplicate_of_id: null,
      duplicate_within_batch_row_id: null, reviewer_decision: 'none', reviewer_reason: null, committed_table: null,
      committed_record_id: null, created_at: now, updated_at: now, fixed_by: null, fixed_at: null, source_page: null,
    });
    void writer.set(orgRow(f, org, 'invoices', inv), {
      id: inv, organization_id: org, invoice_type: 'sales', counterparty_id: c, invoice_number: `B-${i}`,
      issue_date: '2026-07-01', due_date: '2026-07-15', period_id: period, subtotal: '10.00', tax_amount: '0.00',
      total_amount: '10.00', amount_paid: '0.00', balance_due: new Decimal('10').toFixed(2), currency: 'GBP', status: 'open',
      paid_date: null, description: null, source_document_id: documentId, import_batch_id: b, import_row_id: row,
      source_ref: `bi${i}`, record_status: 'accepted', assurance_level: 'verified', dedupe_hash: null,
      duplicate_reviewed: false, superseded_by: null, superseded_at: null, promoted_from_batch_id: null,
      created_at: now, updated_at: now, rejected_reason: null,
    });
    void writer.set(orgRow(f, org, 'record_status_events', ev), {
      id: ev, organization_id: org, record_table: 'invoices', record_id: inv, event: 'accepted',
      related_record_id: null, import_batch_id: b, actor_user_id: null, at: now,
    });
  }
  await writer.close();
}
