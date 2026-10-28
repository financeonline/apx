/**
 * ADR-122 FU-1 — permanent organisations for "an invoice list can state revenue as 0.00 for a month
 * the list does not cover". The rule: a source that does not cover a period must never manufacture a
 * financial zero for it. The invoices source covers a month's P&L and customer figures ONLY when a
 * committed FULL SALES list ESTABLISHES the month — its declared range spans it, or, in the current
 * month (the run's as-of 2026-09-15 falls in September), starts on or before the 1st and reaches into
 * it (revenue to date, `partial_month`). A list's commit date matters only as the last day it can
 * know: its effective range ends at the earlier of its declared end and its commit date, and lists
 * that meet combine (ADR-125). An open-items list and a purchase-only list never cover revenue.
 * Precedence (§2.3) is unchanged: an uncovered month falls
 * to the bank (a cash proxy) or to NULL with `no_source_covers_period` — never 0.00.
 *
 * Raw accepted records under committed batches (the shape a real commit leaves), built with the
 * audit builders; every figure the test reads comes only from a real `calculation.run` job through
 * the queue. Commit times are FIXED (`COMMITTED_AT` = 2026-09-10T10:00Z unless stated), never
 * `now()`. Every invoice is net = gross (tax 0), open and unpaid unless stated, due 30 days after
 * issue. Periods Jan 2026 – Aug 2027 are materialised explicitly, so the months asserted exist
 * whatever the wall clock says when the suite runs.
 *
 * What the pre-FU-1 engine (3.0.0) stated is noted as "was": any invoice batch committed within 45
 * days AFTER a month — or at any time BEFORE it (a negative gap) — "covered" it with `open_items_only`
 * and the P&L summed zero invoice cells for it.
 *
 *   COVERED      full sales list 1 Jun – 31 Aug: Jun 1,000 · Jul 2,000 · Aug 1,500
 *                  → Jun/Jul/Aug those figures, basis invoices; Sep (current, not reached) and Oct NULL
 *                    (was 0.00 open_items_only — Sep 2026 onwards)
 *   ZERO         full sales list 1 Jun – 31 Aug: Jun 1,000 · Aug 1,500, NO July sale
 *                  → Jul 0.00 basis invoices, missing [] — a genuine, STATED zero (R3)
 *   NOTCOVER     full sales list 1 Jun – 30 Jun: Jun 1,000; nothing else
 *                  → Jun 1,000; Jul and Aug NULL no_source_covers_period (was 0.00)
 *   LATERONLY    full sales list 1 Aug – 31 Aug: Aug 1,500
 *                  → Jun, Jul NULL (Jul was 0.00); Aug 1,500
 *   EARLIERONLY  full sales list 1 Jun – 30 Jun, committed 2026-06-05 (BEFORE July): Jun 1,000 (on 06-03)
 *                  → Jun 1,000; Jul, Aug NULL (was 0.00: a negative gap is "within 45 days")
 *   DURING       full sales list declared 1 Jun – 3 Aug, committed 3 Aug: Jun 1,000 · Jul 2,000 · 2 Aug 300
 *                  → Jun 1,000, Jul 2,000; Aug NULL — the list does not span August (not 300, not 0.00)
 *   PRECEDENCE   a GL 1 Jun – 31 Aug (revenue 5,000 · 6,000 · 7,000) AND a full sales list 1 May – 31 Aug
 *                (May 800 · Jun 1,000 · Jul 2,000 · Aug 3,000)
 *                  → Jun/Jul/Aug 5,000 · 6,000 · 7,000 basis ledger (precedence unchanged);
 *                    May 800 basis invoices (only the list covers May)
 *   CURRENT      full sales list declared 1 Jun – 10 Sep, committed 10 Sep: Jun 1,000 · Jul 1,200 ·
 *                Aug 1,500 · 5 Sep 700
 *                  → Aug 1,500 invoices; Sep revenue TO DATE 700.00 invoices with `partial_month`,
 *                    source completeness 10/30, September not complete; Oct NULL
 *   BANKINV      full sales list 1 Jun – 31 Jul (Jun 1,000 · Jul 2,000) + a current account (typed
 *                1,000 at 31 May) with statements Jun – Aug: Jun −100, Jul −100 (uncategorised),
 *                Aug +3,000 on 08-12 categorised to revenue
 *                  → Jun/Jul from the list; Aug 3,000.00 basis bank, assurance estimated,
 *                    cash_basis_proxy (was 0.00 open_items_only: the list was committed 10 days after)
 *   EMPTY        nothing at all → no revenue figure anywhere, never 0
 *   GAPS         full sales lists 1–30 Jun (Jun 1,000) and 1–31 Aug (Aug 1,500) → Jul NULL (was 0.00)
 *   HISTORYFIRST a GL 1 Jan – 31 Mar 2026 (revenue 1,000 a month through cash), then a full sales list
 *                1 Jun – 31 Aug (Jun 1,000 · Jul 2,000 · Aug 1,500)
 *                  → Jan–Mar 1,000 ledger; Apr, May NULL; Jun–Aug from the list
 *   STALE        seeded like NOTCOVER; the test then plants what an older engine wrote (July 0 on 3.0.0)
 *                and the engine-upgrade sweep recomputes July to NULL
 *   CUSTOMER     full sales list 1 Jun – 31 Jul: Jun Acme 500; Jul Acme 3,000 + Beta 1,000
 *                  → Jul revenue 4,000 = Σ customer revenue; top customer 0.75;
 *                    Aug: revenue NULL, no customer revenue stated, top customer NULL (not 100% of 0)
 *   PURCHONLY    a FULL PURCHASE list 1 Jun – 31 Aug: 10 Jul 600, unpaid, due 08-09
 *                  → revenue Jun–Aug NULL (was 0.00 stated by a list with no sales in it);
 *                    payables at 31 Aug 600.00 — AR/AP coverage is unchanged (R4)
 *   OPENITEMS    a sales OPEN-ITEMS (aged-debtors) list as at 31 Jul, declared 1–31 Jul, committed
 *                5 Aug: 20 Jun 2,000 unpaid, due 07-20
 *                  → revenue Jun, Jul NULL (ADR-047.10: an aged-debtors list never defines revenue);
 *                    receivables at 31 Jul 2,000.00 — AR/AP coverage is unchanged (R4)
 */
import { ensurePeriods } from '@/db/app/shared';
import { createAuthUser, fs } from '../integration/setup';
import { acct, bankAccount, counterparty, glBatch, invoiceBatch, type Inv, type GlLine } from './audit-orgs';
import { COMMITTED_AT } from './adr120-orgs';
import { seedAccepted, seedBankTransaction, seedBatch, seedDocument, seedImportRow, seedOrg } from './seed';

export const FU1_KEYS = [
  'COVERED', 'ZERO', 'NOTCOVER', 'LATERONLY', 'EARLIERONLY', 'DURING', 'PRECEDENCE', 'CURRENT',
  'BANKINV', 'EMPTY', 'GAPS', 'HISTORYFIRST', 'STALE', 'CUSTOMER', 'PURCHONLY', 'OPENITEMS',
] as const;
export type Fu1Key = (typeof FU1_KEYS)[number];

/** Seeds the FU-1 organisations (two per owner, like the other fixtures; `create_organization` is throttled per person). */
export async function seedFu1Orgs(tag: string, keys: readonly Fu1Key[]): Promise<Partial<Record<Fu1Key, string>>> {
  const out: Partial<Record<Fu1Key, string>> = {};
  let n = 0;
  let owner = '';
  for (const key of keys) {
    if (n % 2 === 0) owner = await createAuthUser(`fu1-${n}@${tag}.fu1.itest`);
    n += 1;
    const { orgId: org } = await seedOrg({ name: `FU1 ${key} ${tag}`, ownerId: owner });
    out[key] = org;
    // The months the test reads, whatever month the suite happens to run in (create_organization
    // materialises twelve months either side of now(), which drifts).
    await ensurePeriods(fs(), org, '2026-01-01', '2027-08-31');
    await seedOne(key, org);
  }
  return out;
}

const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface Line { readonly issue: string; readonly amount: string; readonly party: string }

/** One invoice per line: net = gross (tax 0), unpaid, open, due 30 days after issue. */
function lines(type: Inv['type'], items: readonly Line[], prefix: string): Inv[] {
  if (items.length === 0) throw new Error('an invoice batch needs at least one invoice (the builder cannot write an empty VALUES list)');
  return items.map((l, i) => ({
    type, party: l.party, number: `${prefix}-${i + 1}`, issue: l.issue, due: addDays(l.issue, 30),
    subtotal: l.amount, tax: '0', total: l.amount, paid: '0', paidDate: null, status: 'open',
  }));
}

/** A committed FULL SALES list over a declared range. */
async function salesList(org: string, o: { start: string; end: string; committedAt?: string; tag: string; sales: readonly Line[] }): Promise<void> {
  await invoiceBatch(org, {
    importType: 'sales_invoices', start: o.start, end: o.end, listKind: 'full', committedAt: o.committedAt ?? COMMITTED_AT,
    tag: o.tag, invoices: lines('sales', o.sales, o.tag),
  });
}

/** Revenue credited against receivables (or cash), one pair of lines per month. */
function revenueLines(amounts: ReadonlyArray<readonly [date: string, amount: string]>, debit: 'receivables' | 'cash'): GlLine[] {
  return amounts.flatMap(([date, amount]) => [
    { date, category: debit, direction: 'debit' as const, amount },
    { date, category: 'revenue', direction: 'credit' as const, amount },
  ]);
}

interface CategorisedMove { readonly date: string; readonly amount: string; readonly category: string | null }

/**
 * One committed statement batch whose transactions may carry a category (category_source `user`).
 * The category is set on INSERT, so the category history the evidence resolver reads opens with it
 * (a later UPDATE would leave the first interval uncategorised).
 */
async function categorisedStatement(org: string, bank: string, o: {
  start: string; end: string; opening: string; closing: string; moves: readonly CategorisedMove[]; tag: string;
}): Promise<void> {
  const documentId = await seedDocument(org, `${o.tag}.csv`, 'bank_statement');
  const b = await seedBatch(org, {
    importType: 'bank_statement', target: 'bank_transactions', start: o.start, end: o.end, committedAt: COMMITTED_AT,
    bankAccountId: bank, statementOpening: o.opening, statementClosing: o.closing, documentId,
  });
  let n = 0;
  for (const m of o.moves) {
    n += 1;
    const row = await seedImportRow(org, b);
    const category = m.category === null ? null : await acct(org, m.category);
    const id = await seedBankTransaction(org, {
      bankAccountId: bank, date: m.date, amount: m.amount, description: `fu1 ${n} ${b}`,
      categoryAccountId: category, categorySource: category === null ? 'none' : 'user',
      documentId, batchId: b, importRowId: row, sourceRef: `b${n}`,
    });
    await seedAccepted(org, 'bank_transactions', id, b);
  }
}

/** The NOTCOVER shape, shared with STALE. */
async function juneOnly(org: string, tag: string): Promise<void> {
  const c = await counterparty(org, 'June Only Ltd', 'customer');
  await salesList(org, { start: '2026-06-01', end: '2026-06-30', tag, sales: [{ issue: '2026-06-10', amount: '1000', party: c }] });
}

async function seedOne(key: Fu1Key, org: string): Promise<void> {
  switch (key) {
    case 'COVERED': {
      const c = await counterparty(org, 'Covered Ltd', 'customer');
      await salesList(org, { start: '2026-06-01', end: '2026-08-31', tag: 'cov', sales: [
        { issue: '2026-06-10', amount: '1000', party: c },
        { issue: '2026-07-10', amount: '2000', party: c },
        { issue: '2026-08-10', amount: '1500', party: c },
      ] });
      break;
    }
    case 'ZERO': {
      const c = await counterparty(org, 'Zero Ltd', 'customer');
      await salesList(org, { start: '2026-06-01', end: '2026-08-31', tag: 'zero', sales: [
        { issue: '2026-06-10', amount: '1000', party: c },
        { issue: '2026-08-10', amount: '1500', party: c },
      ] });
      break;
    }
    case 'NOTCOVER':
      await juneOnly(org, 'nc');
      break;
    case 'STALE':
      await juneOnly(org, 'stale');
      break;
    case 'LATERONLY': {
      const c = await counterparty(org, 'Later Ltd', 'customer');
      await salesList(org, { start: '2026-08-01', end: '2026-08-31', tag: 'later', sales: [{ issue: '2026-08-10', amount: '1500', party: c }] });
      break;
    }
    case 'EARLIERONLY': {
      const c = await counterparty(org, 'Earlier Ltd', 'customer');
      await salesList(org, { start: '2026-06-01', end: '2026-06-30', committedAt: '2026-06-05T09:00:00Z', tag: 'earlier',
        sales: [{ issue: '2026-06-03', amount: '1000', party: c }] });
      break;
    }
    case 'DURING': {
      const c = await counterparty(org, 'During Ltd', 'customer');
      await salesList(org, { start: '2026-06-01', end: '2026-08-03', committedAt: '2026-08-03T12:00:00Z', tag: 'during', sales: [
        { issue: '2026-06-10', amount: '1000', party: c },
        { issue: '2026-07-10', amount: '2000', party: c },
        { issue: '2026-08-02', amount: '300', party: c },
      ] });
      break;
    }
    case 'PRECEDENCE': {
      await glBatch(org, { start: '2026-06-01', end: '2026-08-31', tag: 'prec-gl', lines: revenueLines([
        ['2026-06-05', '5000'], ['2026-07-05', '6000'], ['2026-08-05', '7000'],
      ], 'receivables') });
      const c = await counterparty(org, 'Precedence Ltd', 'customer');
      await salesList(org, { start: '2026-05-01', end: '2026-08-31', tag: 'prec', sales: [
        { issue: '2026-05-10', amount: '800', party: c },
        { issue: '2026-06-10', amount: '1000', party: c },
        { issue: '2026-07-10', amount: '2000', party: c },
        { issue: '2026-08-10', amount: '3000', party: c },
      ] });
      break;
    }
    case 'CURRENT': {
      const c = await counterparty(org, 'Current Ltd', 'customer');
      await salesList(org, { start: '2026-06-01', end: '2026-09-10', committedAt: '2026-09-10T10:00:00Z', tag: 'cur', sales: [
        { issue: '2026-06-10', amount: '1000', party: c },
        { issue: '2026-07-10', amount: '1200', party: c },
        { issue: '2026-08-10', amount: '1500', party: c },
        { issue: '2026-09-05', amount: '700', party: c },
      ] });
      break;
    }
    case 'BANKINV': {
      const c = await counterparty(org, 'BankInv Ltd', 'customer');
      await salesList(org, { start: '2026-06-01', end: '2026-07-31', tag: 'bi', sales: [
        { issue: '2026-06-10', amount: '1000', party: c },
        { issue: '2026-07-10', amount: '2000', party: c },
      ] });
      const bank = await bankAccount(org, '1000', '2026-05-31');
      await categorisedStatement(org, bank, { start: '2026-06-01', end: '2026-06-30', opening: '1000', closing: '900', tag: 'bi-jun',
        moves: [{ date: '2026-06-20', amount: '-100', category: null }] });
      await categorisedStatement(org, bank, { start: '2026-07-01', end: '2026-07-31', opening: '900', closing: '800', tag: 'bi-jul',
        moves: [{ date: '2026-07-20', amount: '-100', category: null }] });
      await categorisedStatement(org, bank, { start: '2026-08-01', end: '2026-08-31', opening: '800', closing: '3800', tag: 'bi-aug',
        moves: [{ date: '2026-08-12', amount: '3000', category: 'revenue' }] });
      break;
    }
    case 'EMPTY':
      break;
    case 'GAPS': {
      const c = await counterparty(org, 'Gaps Ltd', 'customer');
      await salesList(org, { start: '2026-06-01', end: '2026-06-30', tag: 'gaps-jun', sales: [{ issue: '2026-06-10', amount: '1000', party: c }] });
      await salesList(org, { start: '2026-08-01', end: '2026-08-31', tag: 'gaps-aug', sales: [{ issue: '2026-08-10', amount: '1500', party: c }] });
      break;
    }
    case 'HISTORYFIRST': {
      await glBatch(org, { start: '2026-01-01', end: '2026-03-31', tag: 'hf-gl', lines: revenueLines([
        ['2026-01-15', '1000'], ['2026-02-15', '1000'], ['2026-03-15', '1000'],
      ], 'cash') });
      const c = await counterparty(org, 'History Ltd', 'customer');
      await salesList(org, { start: '2026-06-01', end: '2026-08-31', tag: 'hf', sales: [
        { issue: '2026-06-10', amount: '1000', party: c },
        { issue: '2026-07-10', amount: '2000', party: c },
        { issue: '2026-08-10', amount: '1500', party: c },
      ] });
      break;
    }
    case 'CUSTOMER': {
      const acme = await counterparty(org, 'Acme Ltd', 'customer');
      const beta = await counterparty(org, 'Beta plc', 'customer');
      await salesList(org, { start: '2026-06-01', end: '2026-07-31', tag: 'cust', sales: [
        { issue: '2026-06-10', amount: '500', party: acme },
        { issue: '2026-07-05', amount: '3000', party: acme },
        { issue: '2026-07-12', amount: '1000', party: beta },
      ] });
      break;
    }
    case 'PURCHONLY': {
      const s = await counterparty(org, 'Parts Co', 'supplier', 'operating_expense');
      await invoiceBatch(org, { importType: 'purchase_invoices', start: '2026-06-01', end: '2026-08-31', listKind: 'full', tag: 'po',
        invoices: lines('purchase', [{ issue: '2026-07-10', amount: '600', party: s }], 'po') });
      break;
    }
    case 'OPENITEMS': {
      const c = await counterparty(org, 'Open Items Ltd', 'customer');
      await invoiceBatch(org, { importType: 'sales_invoices', start: '2026-07-01', end: '2026-07-31', listKind: 'open_items',
        committedAt: '2026-08-05T09:00:00Z', tag: 'oi', invoices: [
          { type: 'sales', party: c, number: 'OI-1', issue: '2026-06-20', due: '2026-07-20', subtotal: '2000', tax: '0', total: '2000',
            paid: '0', paidDate: null, status: 'open' },
        ] });
      break;
    }
  }
}
