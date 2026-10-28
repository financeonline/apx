import { Decimal } from '@/core/money/decimal';
import { normalizeName } from '@/db/app/shared';
import { orgCollection } from '@/db/schema';
import { createAuthUser, fs } from '../integration/setup';
import {
  seedAccepted, seedBankAccount, seedBankTransaction, seedBatch, seedCounterparty, seedDocument, seedImportRow,
  seedInvoice, seedLedgerEntry, seedOrg, seedPeriodBalance,
} from './seed';

/**
 * Step 0D's additions to the engine comparison: AI-read statements, opening cash carried out of
 * them, mixed assurance across accounts, and customer identity under Unicode names.
 *
 * SELF-CONTAINED on purpose: the comparison job copies this file (and its test) into the BASELINE
 * worktree, so both engines compute the same seeded data. It uses only `../integration/setup` and
 * `./seed` (the Firestore fixture writers), which a Firestore baseline has.
 *
 * Customers are resolved the way `api.create_import_counterparties` resolves them: looked up by the
 * organisation's name key (`normalizeName`), created when the key is new. Each codebase therefore
 * applies ITS OWN key, which is the identity change the comparison must show.
 */

export type Step0dKey = 'AICARRY' | 'AIATTEST' | 'AIMIXED' | 'UNICODE' | 'GLBANK' | 'NOBANK' | 'TBMOVE' | 'TBCUMUL';
/**
 * Step 0E added GLBANK, NOBANK, TBMOVE and TBCUMUL: three months of P&L with at least three Health
 * dimensions, so the comparison shows TOTAL scores (H-1: no bank data; H-2: trial balances).
 */
export const STEP0D_KEYS: readonly Step0dKey[] = ['AICARRY', 'AIATTEST', 'AIMIXED', 'UNICODE', 'GLBANK', 'NOBANK', 'TBMOVE', 'TBCUMUL'];

const COMMITTED_AT = '2026-09-10T10:00:00Z';

type Extraction = 'csv' | 'pdf_text' | 'pdf_claude';

export async function bankAccount(org: string, name: string): Promise<string> {
  return seedBankAccount(org, { name, accountType: 'current' });
}

/**
 * A committed statement and its rows. `extraction` and the rows' assurance are what commit writes
 * (`statementRecordAssurance`): AI-read rows `inferred`; an unreconciled text PDF `calculated`
 * (IMP-BAL-006 on the batch); CSV `verified`.
 */
export async function statement(org: string, bank: string, o: {
  start: string; end: string; extraction: Extraction; unreconciled?: boolean;
  opening?: string; closing?: string; moves: ReadonlyArray<readonly [string, string]>; tag: string;
}): Promise<string> {
  const rowAssurance = o.extraction === 'pdf_claude' ? 'inferred' : o.unreconciled ? 'calculated' : 'verified';
  const documentId = await seedDocument(org, `${o.tag}.${o.extraction === 'csv' ? 'csv' : 'pdf'}`, 'bank_statement');
  const b = await seedBatch(org, {
    importType: 'bank_statement', target: 'bank_transactions', start: o.start, end: o.end, committedAt: COMMITTED_AT,
    bankAccountId: bank, statementOpening: o.opening ?? null, statementClosing: o.closing ?? null,
    extractionMethod: o.extraction, documentId,
    batchIssues: o.unreconciled ? [{ code: 'IMP-BAL-006', severity: 'warning', message: 'does not reconcile' }] : [],
  });
  let n = 0;
  for (const [date, amount] of o.moves) {
    n += 1;
    const row = await seedImportRow(org, b);
    const id = await seedBankTransaction(org, {
      bankAccountId: bank, date, amount, description: `mv ${n} ${b}`, assurance: rowAssurance,
      documentId, batchId: b, importRowId: row, sourceRef: `b${n}`,
    });
    await seedAccepted(org, 'bank_transactions', id, b);
  }
  return b;
}

/** A customer, resolved by the organisation's own name key, exactly as an invoice import resolves one. */
async function customer(org: string, name: string): Promise<string> {
  const found = await orgCollection(fs(), org, 'counterparties').where('normalized_name', '==', normalizeName(name)).limit(1).get();
  if (!found.empty) return found.docs[0]!.id;
  return seedCounterparty(org, { name, kind: 'customer' });
}

/** A full sales list for June–August, one July invoice per name; the name decides the customer. */
async function salesList(org: string, sales: ReadonlyArray<readonly [string, string]>): Promise<void> {
  const parties: string[] = [];
  for (const [name] of sales) parties.push(await customer(org, name));
  const documentId = await seedDocument(org, 'sales.csv', 'invoice');
  const b = await seedBatch(org, {
    importType: 'sales_invoices', target: 'invoices', start: '2026-06-01', end: '2026-08-31', committedAt: COMMITTED_AT,
    listKind: 'full', documentId,
    confirmations: { 'IMP-INV-013': { by: null, at: new Date().toISOString(), value: { opening: 'complete' } } },
  });
  let n = 0;
  for (const [i, [, total]] of sales.entries()) {
    n += 1;
    const row = await seedImportRow(org, b);
    const id = await seedInvoice(org, {
      type: 'sales', counterpartyId: parties[i]!, number: `S-${i + 1}`, issue: '2026-07-10', due: '2026-08-09',
      subtotal: total, tax: '0', total, paid: '0', paidDate: null, status: 'open',
      documentId, batchId: b, importRowId: row, sourceRef: `i${n}${b}`,
    });
    await seedAccepted(org, 'invoices', id, b);
  }
}

/** One of the organisation's seeded accounts of a category (every organisation is seeded with them). */
async function systemAccount(org: string, category: string): Promise<string> {
  const snap = await orgCollection(fs(), org, 'accounts').where('standard_category', '==', category).get();
  const rows = snap.docs.map((d) => d.data()).sort((a, b) =>
    Number(b.is_system === true) - Number(a.is_system === true) || String(a.id).localeCompare(String(b.id)));
  return String(rows[0]?.id ?? '');
}

/** A committed general-ledger batch for one month: revenue in, cost of sales and an expense out, via cash. */
async function ledgerMonth(org: string, ym: string, end: string, revenue: string, cos: string, opex: string): Promise<void> {
  const lines: Array<[string, string, 'debit' | 'credit', string]> = [
    [`${ym}-05`, 'cash', 'debit', revenue], [`${ym}-05`, 'revenue', 'credit', revenue],
    [`${ym}-12`, 'cost_of_sales', 'debit', cos], [`${ym}-12`, 'cash', 'credit', cos],
    [`${ym}-25`, 'operating_expense', 'debit', opex], [`${ym}-25`, 'cash', 'credit', opex],
  ];
  const documentId = await seedDocument(org, 'gl.csv', 'general_ledger');
  const b = await seedBatch(org, {
    importType: 'general_ledger', target: 'ledger_entries', start: `${ym}-01`, end, committedAt: COMMITTED_AT, documentId,
  });
  let n = 0;
  for (const [date, category, direction, amount] of lines) {
    n += 1;
    const row = await seedImportRow(org, b);
    const id = await seedLedgerEntry(org, {
      date, accountId: await systemAccount(org, category), direction, amount,
      documentId, batchId: b, importRowId: row, sourceRef: `g${n}${b}`,
    });
    await seedAccepted(org, 'ledger_entries', id, b);
  }
}

/**
 * A committed trial balance for one month: rows in natural sign (`closing_balance`), as commit stores
 * them. No debit/credit totals — no import writes them for a single-balance file.
 */
async function trialBalanceMonth(
  org: string, ym: string, end: string, basis: 'movement' | 'cumulative', rows: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  const documentId = await seedDocument(org, 'tb.csv', 'trial_balance');
  const b = await seedBatch(org, {
    importType: 'trial_balance', target: 'period_balances', start: `${ym}-01`, end, committedAt: COMMITTED_AT,
    balanceBasis: basis, documentId,
  });
  let n = 0;
  for (const [category, value] of rows) {
    n += 1;
    const row = await seedImportRow(org, b);
    const id = await seedPeriodBalance(org, {
      periodStart: `${ym}-01`, accountId: await systemAccount(org, category), closing: value, kind: 'trial_balance', basis,
      documentId, batchId: b, importRowId: row, sourceRef: `p${n}${b}`,
    });
    await seedAccepted(org, 'period_balances', id, b);
  }
}

const HT_MONTHS: ReadonlyArray<readonly [string, string, string, string, string]> = [
  // month, end, revenue, cost of sales, operating expense
  ['2026-06', '2026-06-30', '1000', '400', '300'],
  ['2026-07', '2026-07-31', '1100', '440', '300'],
  ['2026-08', '2026-08-31', '1210', '484', '300'],
];

async function seedOne(key: Step0dKey, org: string): Promise<void> {
  switch (key) {
    case 'AICARRY': {
      // June CSV (printed 10,000 → 9,000); July READ BY AI; August CSV with no printed balance.
      // Truth: Jun 9,000 · Jul 8,500 · Aug 8,700. August's opening and closing are carried through July.
      const main = await bankAccount(org, 'Main');
      await statement(org, main, { start: '2026-06-01', end: '2026-06-30', extraction: 'csv', opening: '10000', closing: '9000', moves: [['2026-06-10', '-1000']], tag: 'ac-jun' });
      await statement(org, main, { start: '2026-07-01', end: '2026-07-31', extraction: 'pdf_claude', moves: [['2026-07-03', '2000'], ['2026-07-18', '-2500']], tag: 'ac-jul' });
      await statement(org, main, { start: '2026-08-01', end: '2026-08-31', extraction: 'csv', moves: [['2026-08-05', '3000'], ['2026-08-20', '-2800']], tag: 'ac-aug' });
      break;
    }
    case 'AIATTEST': {
      // As AICARRY, but August's CSV prints its opening (8,500), which agrees with the chain.
      const main = await bankAccount(org, 'Main');
      await statement(org, main, { start: '2026-06-01', end: '2026-06-30', extraction: 'csv', opening: '10000', closing: '9000', moves: [['2026-06-10', '-1000']], tag: 'at-jun' });
      await statement(org, main, { start: '2026-07-01', end: '2026-07-31', extraction: 'pdf_claude', moves: [['2026-07-03', '2000'], ['2026-07-18', '-2500']], tag: 'at-jul' });
      await statement(org, main, { start: '2026-08-01', end: '2026-08-31', extraction: 'csv', opening: '8500', moves: [['2026-08-05', '3000'], ['2026-08-20', '-2800']], tag: 'at-aug' });
      break;
    }
    case 'AIMIXED': {
      // Two accounts. Main: July read by AI. Reserve: July an UNRECONCILED text PDF. August CSV on both.
      const main = await bankAccount(org, 'Main');
      const reserve = await bankAccount(org, 'Reserve');
      await statement(org, main, { start: '2026-06-01', end: '2026-06-30', extraction: 'csv', opening: '5000', moves: [['2026-06-12', '-400']], tag: 'am-m-jun' });
      await statement(org, main, { start: '2026-07-01', end: '2026-07-31', extraction: 'pdf_claude', moves: [['2026-07-12', '-300']], tag: 'am-m-jul' });
      await statement(org, main, { start: '2026-08-01', end: '2026-08-31', extraction: 'csv', moves: [['2026-08-12', '1200']], tag: 'am-m-aug' });
      await statement(org, reserve, { start: '2026-06-01', end: '2026-06-30', extraction: 'csv', opening: '2000', moves: [['2026-06-15', '100']], tag: 'am-r-jun' });
      await statement(org, reserve, { start: '2026-07-01', end: '2026-07-31', extraction: 'pdf_text', unreconciled: true, moves: [['2026-07-15', '100']], tag: 'am-r-jul' });
      await statement(org, reserve, { start: '2026-08-01', end: '2026-08-31', extraction: 'csv', moves: [['2026-08-15', '100']], tag: 'am-r-aug' });
      break;
    }
    case 'GLBANK': {
      // A ledger and a bank that mirrors it (CSV statements): the control. Health scores on both engines.
      for (const [ym, end, r, c, o] of HT_MONTHS) await ledgerMonth(org, ym, end, r, c, o);
      const main = await bankAccount(org, 'Main');
      for (const [ym, end, r, c, o] of HT_MONTHS) {
        await statement(org, main, { start: `${ym}-01`, end, extraction: 'csv', ...(ym === '2026-06' ? { opening: '5000', closing: '5300' } : {}),
          moves: [[`${ym}-05`, r], [`${ym}-12`, `-${c}`], [`${ym}-25`, `-${o}`]], tag: `gb-${ym}` });
      }
      break;
    }
    case 'NOBANK': {
      // The same ledger and NO bank account (H-1: banking must not be scored).
      for (const [ym, end, r, c, o] of HT_MONTHS) await ledgerMonth(org, ym, end, r, c, o);
      break;
    }
    case 'TBMOVE': {
      // The same P&L as a MOVEMENT trial balance, no bank (H-2).
      for (const [ym, end, r, c, o] of HT_MONTHS) {
        await trialBalanceMonth(org, ym, end, 'movement', [['revenue', `-${r}`], ['cost_of_sales', c], ['operating_expense', o]]);
      }
      break;
    }
    case 'TBCUMUL': {
      // The same P&L as a CUMULATIVE (year-to-date) trial balance, fiscal year from the organisation's default.
      const ytd: Record<string, [string, string, string]> = { '2026-06': ['-1000', '400', '300'], '2026-07': ['-2100', '840', '600'], '2026-08': ['-3310', '1324', '900'] };
      for (const [ym, end] of HT_MONTHS) {
        const [r, c, o] = ytd[ym]!;
        await trialBalanceMonth(org, ym, end, 'cumulative', [['revenue', r], ['cost_of_sales', c], ['operating_expense', o]]);
      }
      break;
    }
    case 'UNICODE': {
      // One July invoice per name. Under the baseline key the five non-Latin names are ONE customer
      // (key '') and Möller is Müller; under the Unicode key there are ten customers — the Greek
      // name in two cases is one; "İzmir Ltd" and "Izmir Ltd" are two (D-3: İ keeps its dot).
      await salesList(org, [
        ['Müller GmbH', '5000'], ['Möller GmbH', '3000'], ['Muller GmbH', '1000'],
        ['株式会社トヨタ', '4000'], ['شركة الأمل', '3500'], ['ΟΔΟΣ Α.Ε.', '1500'], ['οδος α.ε.', '1500'],
        ['ООО «Ромашка»', '2000'], ['İzmir Ltd', '800'], ['Izmir Ltd', '700'],
      ]);
      break;
    }
  }
}

export async function seedStep0dOrgs(tag: string): Promise<Record<Step0dKey, string>> {
  const out = {} as Record<Step0dKey, string>;
  for (const key of STEP0D_KEYS) {
    // One owner per organisation: `create_organization` is throttled per user.
    const owner = await createAuthUser(`s0d-${key.toLowerCase()}@${tag}.step0d.itest`);
    out[key] = (await seedOrg({ name: `STEP0D ${key} ${tag}`, ownerId: owner })).orgId;
    await seedOne(key, out[key]);
  }
  return out;
}

/** Who the organisation's invoices are booked to: `name|invoices|total`, by name. */
export async function identityDump(org: string): Promise<string[]> {
  const [parties, invoices] = await Promise.all([
    orgCollection(fs(), org, 'counterparties').get(), orgCollection(fs(), org, 'invoices').get(),
  ]);
  const idsByName = new Map<string, Set<string>>();
  for (const c of parties.docs) {
    const name = String(c.get('name'));
    if (!idsByName.has(name)) idsByName.set(name, new Set());
    idsByName.get(name)!.add(c.id);
  }
  const out: string[] = [];
  for (const name of [...idsByName.keys()].sort()) {
    const ids = idsByName.get(name)!;
    const mine = invoices.docs.filter((i) => ids.has(String(i.get('counterparty_id'))));
    const total = mine.reduce((acc, i) => acc.plus(String(i.get('total_amount'))), new Decimal(0));
    out.push(`${name}|${mine.length}|${total.toFixed(2)}`);
  }
  return out;
}
