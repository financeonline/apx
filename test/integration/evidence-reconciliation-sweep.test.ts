import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolveDescriptor } from '@/modules/evidence';
import type { AccessContext } from '@/modules/tenancy';
import { orgRow } from '@/db/schema';
import { clientFor, createAuthUser, deleteOrg, drainUntilFinished, fs } from './setup';
import { createOrgFixture } from './r-fixtures';
import {
  accountFor, drainShared, deleteAuthUsers, deleteJobsOf, queueCalculation, seedBankAccount, seedBankTransaction, seedBatch,
  seedCounterparty, seedDocument, seedImportRow, seedInvoice, seedLedgerEntry, seedStatusEvent,
} from './evidence-fixtures';

/**
 * Every leaf descriptor an organisation produces must reconcile to the figure it sits behind
 * (ADR-109).
 *
 * Phase 14 fixed this invariant four times in four places: the amount basis (ADR-105), voided
 * invoices (ADR-107), merged counterparties (ADR-108), and `other_income` (ADR-109). Each fix was
 * correct and local, and each time the next audit found another family where the same invariant was
 * broken, because nothing checked the families no one had thought to test.
 *
 * This is that check. It does not name metrics. It seeds three organisations on the three P&L bases,
 * reads EVERY row of `metric_current` whose snapshot carries a leaf descriptor, resolves each
 * descriptor through the real evidence service under the owner's read policies (`src/db/rls.ts`), and asserts that the sum of
 * what comes back equals the figure. A new figure with a new descriptor joins this test by existing;
 * a descriptor that selects the wrong population fails it without anyone having predicted the shape
 * of the mistake.
 *
 * The fixture deliberately includes rows the figures exclude — voided invoices, a credit note, an
 * uncategorised payment, a matched transfer pair and an unpaired transfer candidate, ledger accounts
 * with entries on both sides, and contacts on payables, receivables and bank lines — so that a
 * descriptor which is merely too broad, or totalled in the wrong sign, is caught rather than flattered.
 *
 * The bank rows that carry a category are categorised by the USER. The banking pass re-derives `rule`
 * categories, and with no rule to match it cleared them, so every bank P&L and counterparty line in
 * this fixture used to be a zero — which is how HIGH-3 and the negative bank expense drill-down both
 * sat behind a green sweep (ADR-110). No family is exempt: HIGH-3 is closed.
 */
const RUN = `sw${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.sweep.itest.motion`;
let owner: string; let owner2: string;
const ownerOf = new Map<string, string>();
const whose = (o: string) => ownerOf.get(o) ?? owner;
const orgs: Array<{ id: string; label: string }> = [];

const ctxFor = (org: string): AccessContext => ({
  userId: whose(org), orgId: org, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(whose(org)), requestId: RUN, now: () => new Date('2026-09-15T00:00:00Z'), organizationStatus: 'active',
});
async function createOrg(name: string, who: string): Promise<string> {
  const id = (await createOrgFixture({ name, ownerId: who })).id;
  ownerOf.set(id, who); return id;
}
const cp = (org: string, name: string, kind: string, cat: string | null = null) =>
  seedCounterparty(org, { name, kind, defaultExpenseCategory: cat });
const acct = accountFor;
async function calc(org: string) {
  const j = await queueCalculation(org, { trigger: 'recalc_manual', as_of: '2026-09-15' });
  expect(await drainUntilFinished(drainShared, j)).toBe('succeeded');
}
const OPENING_CONFIRMED = { 'IMP-INV-013': { by: null, at: '2026-09-01T00:00:00Z', value: { opening: 'complete' } } };

beforeAll(async () => {
  owner = await createAuthUser(`o1@${DOMAIN}`); owner2 = await createAuthUser(`o2@${DOMAIN}`);

  // ---------- INVOICE basis ----------
  const iOrg = await createOrg(`ITest Sweep inv ${RUN}`, owner); orgs.push({ id: iOrg, label: 'invoice' });
  const c1 = await cp(iOrg, 'Cust One', 'customer'); const c2 = await cp(iOrg, 'Cust Two', 'customer');
  const s1 = await cp(iOrg, 'Stock', 'supplier', 'cost_of_sales');
  const s2 = await cp(iOrg, 'Ads', 'supplier', 'marketing');
  const s3 = await cp(iOrg, 'Bank Chg', 'supplier', 'interest_expense');
  const invoices: string[] = [];
  const inv = async (t: string, c: string, n: string, sub: string, st = 'open') => {
    const tax = new Decimal(sub).times('0.2').toFixed(2);
    const id = await seedInvoice(iOrg, {
      type: t, counterpartyId: c, number: n, issueDate: '2026-08-10', dueDate: '2026-09-09', subtotal: sub, tax,
      total: new Decimal(sub).plus(tax).toFixed(2), paid: '0', status: st, recordStatus: 'accepted', assurance: 'verified',
    });
    invoices.push(id);
    return id;
  };
  await inv('sales', c1, 'S1', '14000.00'); await inv('sales', c2, 'S2', '6000.00');
  await inv('sales_credit_note', c1, 'CN1', '1500.00');
  await inv('sales', c1, 'SV', '9999.00', 'void');
  await inv('purchase', s1, 'P1', '3200.00'); await inv('purchase', s2, 'P2', '1100.00'); await inv('purchase', s3, 'P3', '260.00');
  await inv('purchase', s1, 'PV', '7777.00', 'void');
  for (const id of invoices) await seedStatusEvent(iOrg, { table: 'invoices', recordId: id, event: 'accepted' });
  const idoc = await seedDocument(iOrg, { name: 'i.csv', kind: 'invoice' });
  await seedBatch(iOrg, {
    documentId: idoc, importType: 'sales_invoices', targetTable: 'invoices', status: 'committed',
    periodStart: '2026-08-01', periodEnd: '2026-08-31', invoiceListKind: 'full', confirmations: OPENING_CONFIRMED,
  });
  // FU-12: costs need a full purchase list (ADR-126).
  await seedBatch(iOrg, {
    documentId: idoc, importType: 'purchase_invoices', targetTable: 'invoices', status: 'committed',
    periodStart: '2026-08-01', periodEnd: '2026-08-31', invoiceListKind: 'full', confirmations: OPENING_CONFIRMED,
  });
  await calc(iOrg);

  // ---------- LEDGER basis ----------
  const lOrg = await createOrg(`ITest Sweep led ${RUN}`, owner2); orgs.push({ id: lOrg, label: 'ledger' });
  const lc = await cp(lOrg, 'L Cust', 'customer'); const ls = await cp(lOrg, 'L Supp', 'supplier');
  const ldoc = await seedDocument(lOrg, { name: 'g.csv', kind: 'general_ledger' });
  const lb = await seedBatch(lOrg, {
    documentId: ldoc, importType: 'general_ledger', targetTable: 'ledger_entries', status: 'committed',
    periodStart: '2026-08-01', periodEnd: '2026-08-31',
  });
  let n = 0;
  const entry = async (cat: string, dir: 'debit' | 'credit', amt: string, party: string | null) => {
    n += 1;
    const row = await seedImportRow(lOrg, { batchId: lb, rowNumber: n, sourceRef: `r${n}` });
    const e = await seedLedgerEntry(lOrg, {
      date: '2026-08-15', accountId: await acct(lOrg, cat), direction: dir, amount: amt, status: 'accepted',
      documentId: ldoc, batchId: lb, importRowId: row, sourceRef: `r${n}`, counterpartyId: party,
    });
    await seedStatusEvent(lOrg, { table: 'ledger_entries', recordId: e, event: 'accepted', batchId: lb });
  };
  await entry('revenue', 'credit', '18000.00', lc); await entry('revenue', 'credit', '2400.00', null);
  await entry('cost_of_sales', 'debit', '5200.00', ls); await entry('marketing', 'debit', '900.00', ls);
  await entry('payroll', 'debit', '4300.00', null); await entry('interest_expense', 'debit', '150.00', null);
  await entry('other_income', 'credit', '700.00', null);
  // Both sides of one account, and a contact on the settling lines of its own journals, as a
  // general-ledger export prints it: a refund, a supplier credit, and the payables and bank legs.
  // Without these every ledger account was one-sided and HIGH-5 and HIGH-6 passed unseen (ADR-111).
  await entry('revenue', 'debit', '600.00', lc); await entry('cost_of_sales', 'credit', '250.00', ls);
  await entry('payables', 'credit', '5200.00', ls); await entry('payables', 'debit', '5200.00', ls); await entry('cash', 'credit', '5200.00', ls);
  await entry('receivables', 'debit', '18000.00', lc);
  await calc(lOrg);

  // ---------- BANK basis, with a transfer pair and an UNPAIRED transfer candidate ----------
  const bOrg = await createOrg(`ITest Sweep bank ${RUN}`, owner2); orgs.push({ id: bOrg, label: 'bank' });
  const bc = await cp(bOrg, 'B Cust', 'customer'); const bs = await cp(bOrg, 'B Supp', 'supplier');
  const mk = (name: string, type: string, open: string) =>
    seedBankAccount(bOrg, { name, accountType: type, openingBalance: open, openingBalanceDate: '2026-08-01' });
  const main = await mk('Main', 'current', '5000.00'); const savings = await mk('Savings', 'savings', '1000.00');
  const bdoc = await seedDocument(bOrg, { name: 'b.csv', kind: 'bank_statement' });
  const bb = await seedBatch(bOrg, {
    documentId: bdoc, importType: 'bank_statement', targetTable: 'bank_transactions', status: 'committed',
    periodStart: '2026-08-01', periodEnd: '2026-08-31', bankAccountId: main,
  });
  let m = 0;
  const tx = async (bank: string, amt: string, desc: string, cat: string | null, kind = 'none') => {
    m += 1;
    const row = await seedImportRow(bOrg, { batchId: bb, rowNumber: m, sourceRef: `t${m}` });
    const t = await seedBankTransaction(bOrg, {
      bankAccountId: bank, date: '2026-08-16', amount: amt, description: desc,
      categorySource: cat === null ? 'none' : 'user', status: 'accepted', documentId: bdoc, batchId: bb,
      importRowId: row, sourceRef: `t${m}`, counterpartyId: cat === 'revenue' ? bc : bs,
      categoryAccountId: cat === null ? null : await acct(bOrg, cat), isTransfer: kind !== 'none', transferKind: kind,
    });
    await seedStatusEvent(bOrg, { table: 'bank_transactions', recordId: t, event: 'accepted', batchId: bb });
    return t;
  };
  await tx(main, '12000.00', 'CUSTOMER RECEIPT', 'revenue');
  await tx(main, '-3400.00', 'SUPPLIER PAYMENT', 'cost_of_sales');
  await tx(main, '-800.00', 'ADVERTISING', 'marketing');
  // A matched pair between own accounts: both legs should be excluded from inflows/outflows.
  await tx(main, '-2000.00', 'TRANSFER TO SAVINGS', null, 'cash_transfer');
  await tx(savings, '2000.00', 'TRANSFER FROM MAIN', null, 'cash_transfer');
  // An UNPAIRED transfer candidate: flagged, but with no matching leg it is still money out.
  await tx(main, '-650.00', 'TRANSFER TO ELSEWHERE', null, 'cash_transfer');
  await calc(bOrg);
}, 900_000);

afterAll(async () => {
  for (const { id } of orgs) {
    await deleteJobsOf(id);
    await deleteOrg(id);
  }
  await deleteAuthUsers(DOMAIN);
});

/** Every current cell whose snapshot carries a leaf descriptor, ordered by metric key then dimension. */
async function leafCells(org: string) {
  const cells = (await fs().collection('organizations').doc(org).collection('metric_current').get()).docs.map((d) => d.data());
  const out: Array<{ key: string; dim: string; dimType: string; value: string; unit: string; basis: string; descriptor: unknown }> = [];
  for (const c of cells) {
    const s = (await orgRow(fs(), org, 'metric_snapshots', String(c.snapshot_id)).get()).data();
    const q = s?.evidence_query as { kind?: string; descriptor?: unknown } | null | undefined;
    if (!s || !q || q.kind !== 'leaf') continue;
    out.push({
      key: String(c.metric_key), dim: (c.dimension_id as string | null) ?? '-', dimType: String(c.dimension_type),
      value: s.value === null || s.value === undefined ? 'NULL' : String(s.value), unit: String(s.unit),
      basis: String(s.basis), descriptor: q.descriptor,
    });
  }
  return out.sort((a, b) => (a.key !== b.key ? (a.key < b.key ? -1 : 1) : a.dim < b.dim ? -1 : a.dim > b.dim ? 1 : 0));
}

describe('every leaf descriptor reconciles to its figure (ADR-109)', () => {
  it('walks every leaf descriptor three organisations produce', async () => {
    let checked = 0; const mismatches: string[] = [];
    for (const { id: org, label } of orgs) {
      for (const { key, dim, dimType, value, unit, basis, descriptor } of await leafCells(org)) {
        const sel = await resolveDescriptor(ctxFor(org), descriptor);
        checked += 1;
        const fig = value === 'NULL' ? 'NULL' : new Decimal(value!).toFixed(2);
        const tot = sel.total === null ? 'NULL' : new Decimal(sel.total).toFixed(2);
        const ok = fig === tot;
        const note = `${label} ${key}${dim === '-' ? '' : `[${dimType}]`} unit=${unit} basis=${basis} figure=${fig} evidence=${tot} rows=${sel.count}`;
        if (!ok) mismatches.push(note);
      }
    }
    console.log(`SWEEP checked ${checked}, mismatches ${mismatches.length}`);
    // A sweep that checked nothing would pass silently, so the fixture's own output is asserted too.
    expect(checked, 'the fixture must produce leaf descriptors to check').toBeGreaterThan(40);
    expect(mismatches, `figure != Σ evidence:\n${mismatches.join('\n')}`).toEqual([]);
  });
});
