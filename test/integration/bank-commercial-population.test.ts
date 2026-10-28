import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolvePeriodContext, TOOLS } from '@/modules/ai';
import { loadPeriods, loadPeriodsWithData } from '@/modules/dashboard';
import { resolveDescriptor } from '@/modules/evidence';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { writeRecordStatusEvent } from '@/db/app/shared';
import { orgCollection, orgRow } from '@/db/schema';
import { clientFor, createAuthUser, drainUntilFinished, fs } from './setup';
import {
  dropFixtures, makeOrg, periodFor, queueCalculation, rowOf, rowsOf, seedBankAccount, seedBankTxn, seedBatch,
  seedCounterparty, seedDocument, seedImportRow, systemAccount,
} from './f-fixtures';

/**
 * HIGH-3: on the bank basis, a counterparty's figure and its evidence are one population (ADR-110).
 *
 * Before ADR-110 a bank-basis supplier's figure was Σ|amount| over every cell for that party that was
 * not revenue-categorised — uncategorised rows, transfer legs and inflows included — while the
 * descriptor behind it selected expense-category, non-cash-transfer outflows. The release check of
 * `621f9e6` measured a supplier at 8,850.00 over a drill-down of 0.00.
 *
 * Every row below is one the contract has an answer for, and most are rows the old figure took and
 * the new one must not: a transfer leg categorised as revenue or as an expense, an uncategorised
 * payment, an owner's capital injection, other income, a loan repayment, drawings, a supplier refund.
 * The test drives the real pipeline — rows → `calculation.run` → snapshot → descriptor → the evidence
 * service under the owner's read policies → an independent sum of the rows it returned — and checks the rows
 * themselves, not only the totals, so a population that happened to add up to the right number over
 * the wrong rows still fails.
 *
 * The commercial rows are categorised by the USER, because the banking pass re-derives `rule`
 * categories and would otherwise decide the population before the engine sees it.
 */

vi.setConfig({ testTimeout: 180_000 });

const RUN = `bc${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.bankcommercial.itest.motion`;

let owner: string;
let org: string;
let emptyOrg: string;
const party = new Map<string, string>();
const txn = new Map<string, string>();

const ctxFor = (orgId: string): AccessContext => ({
  userId: owner, orgId, orgSlug: 'bc', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(owner), requestId: `itest-${RUN}`,
  now: () => new Date('2026-09-15T00:00:00Z'), organizationStatus: 'active',
});

const createOrg = (name: string): Promise<string> => makeOrg(owner, name);

async function calc(orgId: string) {
  const j = await queueCalculation(orgId, { trigger: 'recalc_manual', as_of: '2026-09-15' });
  expect(await drainUntilFinished(drainJobs, j, 60)).toBe('succeeded');
}

/** A bank organisation with a statement batch; returns a row writer. */
async function bankOrg(orgId: string) {
  const accounts = new Map<string, string>();
  const acct = async (cat: string) => {
    if (!accounts.has(cat)) accounts.set(cat, await systemAccount(orgId, cat));
    return accounts.get(cat)!;
  };
  const bank = (name: string, type: string) => seedBankAccount(orgId, {
    name, bankName: 'Test Bank', type, openingBalance: '0.00', openingBalanceDate: '2026-08-01', currency: 'GBP',
  });
  const main = await bank('Main', 'current');
  const savings = await bank('Savings', 'savings');
  const card = await bank('Card', 'credit_card');
  const doc = await seedDocument(orgId, { filename: 'b.csv', kind: 'bank_statement' });
  const batch = await seedBatch(orgId, {
    documentId: doc, importType: 'bank_statement', targetTable: 'bank_transactions', status: 'committed',
    periodStart: '2026-08-01', periodEnd: '2026-08-31', bankAccountId: main,
  });
  let n = 0;
  const tx = async (o: {
    key: string; bank: string; amount: string; party: string | null; cat: string | null; kind?: string;
  }) => {
    n += 1;
    const kind = o.kind ?? 'none';
    const row = await seedImportRow(orgId, { batchId: batch, rowNumber: n, status: 'committed', sourceRef: `t${n}` });
    const id = await seedBankTxn(orgId, {
      bankAccountId: o.bank, date: `2026-08-${String(10 + (n % 15)).padStart(2, '0')}`, amount: o.amount, currency: 'GBP',
      description: o.key, descriptionRaw: o.key, categorySource: o.cat === null ? 'none' : 'user', duplicateReviewed: true,
      sourceDocumentId: doc, importBatchId: batch, importRowId: row, sourceRef: `t${n}`, counterpartyId: o.party,
      categoryAccountId: o.cat === null ? null : await acct(o.cat), isTransfer: kind !== 'none', transferKind: kind,
    });
    await fs().runTransaction(async (t) => {
      writeRecordStatusEvent(t, fs(), { orgId, table: 'bank_transactions', recordId: id, event: 'accepted', actorId: null, batchId: batch });
    });
    txn.set(o.key, id);
    return id;
  };
  const pair = async (a: string, b: string) => {
    await orgRow(fs(), orgId, 'bank_transactions', a).update({ transfer_pair_id: b });
    await orgRow(fs(), orgId, 'bank_transactions', b).update({ transfer_pair_id: a });
  };
  return { main, savings, card, tx, pair };
}

const cp = async (orgId: string, name: string, kind: string) => {
  const id = await seedCounterparty(orgId, { name, kind });
  party.set(name, id);
  return id;
};

beforeAll(async () => {
  owner = await createAuthUser(`owner@${DOMAIN}`);
  org = await createOrg(`BC ${RUN}`);
  const b = await bankOrg(org);
  const C1 = await cp(org, 'Customer One', 'customer');
  const C2 = await cp(org, 'Customer Two', 'customer');
  const C3 = await cp(org, 'Customer Three', 'customer');
  const S1 = await cp(org, 'Supplier One', 'supplier');
  const S2 = await cp(org, 'Supplier Two', 'supplier');
  const S3 = await cp(org, 'Supplier Three', 'supplier');

  // ---- CASE B: customer revenue ----
  await b.tx({ key: 'C1 SALE A', bank: b.main, amount: '10000.00', party: C1, cat: 'revenue' });
  await b.tx({ key: 'C1 SALE B', bank: b.main, amount: '2500.00', party: C1, cat: 'revenue' });
  await b.tx({ key: 'C1 REFUND', bank: b.main, amount: '-400.00', party: C1, cat: 'revenue' });
  await b.tx({ key: 'C1 UNCATEGORISED IN', bank: b.main, amount: '1300.00', party: C1, cat: null });
  await b.tx({ key: 'C1 OTHER INCOME', bank: b.main, amount: '700.00', party: C1, cat: 'other_income' });
  await b.tx({ key: 'C2 SALE', bank: b.main, amount: '4000.00', party: C2, cat: 'revenue' });
  await b.tx({ key: 'C2 OWNER FUNDING', bank: b.main, amount: '5000.00', party: C2, cat: 'equity' });
  // A cash transfer whose incoming leg still carries a revenue category, as a hand-marked pair does.
  const tIn = await b.tx({ key: 'C2 TRANSFER IN (revenue-categorised)', bank: b.main, amount: '3000.00', party: C2, cat: 'revenue', kind: 'cash_transfer' });
  const tOut = await b.tx({ key: 'C2 TRANSFER OUT', bank: b.savings, amount: '-3000.00', party: C2, cat: 'transfer', kind: 'cash_transfer' });
  await b.pair(tIn, tOut);
  await b.tx({ key: 'UNNAMED SALE', bank: b.main, amount: '1200.00', party: null, cat: 'revenue' });

  // ---- CASE A: supplier spend ----
  await b.tx({ key: 'S1 STOCK', bank: b.main, amount: '-3200.00', party: S1, cat: 'cost_of_sales' });
  await b.tx({ key: 'S1 RENT', bank: b.main, amount: '-1150.00', party: S1, cat: 'operating_expense' });
  await b.tx({ key: 'S1 UNCATEGORISED OUT', bank: b.main, amount: '-2750.00', party: S1, cat: null });
  await b.tx({ key: 'S1 LOAN REPAYMENT', bank: b.main, amount: '-500.00', party: S1, cat: 'loan' });
  // A card repayment whose paying leg still carries an expense category.
  const rOut = await b.tx({ key: 'S1 CARD REPAYMENT (expense-categorised)', bank: b.main, amount: '-1800.00', party: S1, cat: 'operating_expense', kind: 'card_repayment' });
  const rIn = await b.tx({ key: 'S1 CARD REPAYMENT IN', bank: b.card, amount: '1800.00', party: S1, cat: 'operating_expense', kind: 'card_repayment' });
  await b.pair(rOut, rIn);
  await b.tx({ key: 'S2 ADS', bank: b.main, amount: '-900.00', party: S2, cat: 'marketing' });
  await b.tx({ key: 'S2 REFUND IN', bank: b.main, amount: '250.00', party: S2, cat: 'marketing' });
  await b.tx({ key: 'S2 DRAWINGS', bank: b.main, amount: '-600.00', party: S2, cat: 'drawings' });
  await b.tx({ key: 'UNNAMED EXPENSE', bank: b.main, amount: '-700.00', party: null, cat: 'operating_expense' });

  // ---- CASE C: the HIGH-3 shape — a party whose only rows are uncategorised or transfers ----
  await b.tx({ key: 'S3 UNCATEGORISED', bank: b.main, amount: '-4100.00', party: S3, cat: null });
  const s3Out = await b.tx({ key: 'S3 TRANSFER OUT', bank: b.main, amount: '-2020.00', party: S3, cat: 'transfer', kind: 'cash_transfer' });
  const s3In = await b.tx({ key: 'S3 TRANSFER IN', bank: b.savings, amount: '2020.00', party: S3, cat: 'transfer', kind: 'cash_transfer' });
  await b.pair(s3Out, s3In);
  await b.tx({ key: 'C3 UNCATEGORISED IN', bank: b.main, amount: '2600.00', party: C3, cat: null });
  await calc(org);

  // ---- CASE E: a bank organisation with no eligible commercial row at all ----
  emptyOrg = await createOrg(`BC empty ${RUN}`);
  const e = await bankOrg(emptyOrg);
  const eS = await cp(emptyOrg, 'Empty Supplier', 'supplier');
  const eC = await cp(emptyOrg, 'Empty Customer', 'customer');
  await e.tx({ key: 'E UNCATEGORISED OUT', bank: e.main, amount: '-1500.00', party: eS, cat: null });
  await e.tx({ key: 'E UNCATEGORISED IN', bank: e.main, amount: '800.00', party: eC, cat: null });
  const eOut = await e.tx({ key: 'E TRANSFER OUT', bank: e.main, amount: '-400.00', party: eS, cat: 'transfer', kind: 'cash_transfer' });
  const eIn = await e.tx({ key: 'E TRANSFER IN', bank: e.savings, amount: '400.00', party: eS, cat: 'transfer', kind: 'cash_transfer' });
  await e.pair(eOut, eIn);
  await calc(emptyOrg);
}, 900_000);

afterAll(async () => {
  if (process.env.KEEP_BC) return;
  await dropFixtures([org, emptyOrg], DOMAIN);
}, 60_000);

interface Snap { snapshotId: string; value: string | null; basis: string; descriptor: unknown }

async function snapshot(orgId: string, key: string, dimensionId: string | null): Promise<Snap | null> {
  let q: FirebaseFirestore.Query = orgCollection(fs(), orgId, 'metric_current')
    .where('metric_key', '==', key).where('period_id', '==', await periodFor(orgId, '2026-08-01'));
  q = dimensionId === null
    ? q.where('dimension_id', '==', null).where('dimension_type', '==', key === 'revenue' ? 'none' : 'counterparty')
    : q.where('dimension_id', '==', dimensionId);
  const cell = (await q.limit(1).get()).docs[0];
  if (!cell) return null;
  const s = (await rowOf(orgId, 'metric_snapshots', String(cell.get('snapshot_id'))))!;
  // The Unattributed rows store a null query.
  const query = (s.evidence_query ?? null) as { descriptor?: unknown } | null;
  return {
    snapshotId: String(s.id), value: s.value === null || s.value === undefined ? null : String(s.value), basis: String(s.basis),
    descriptor: query?.descriptor ?? null,
  };
}

/** Figure, evidence total, independent Σ of the returned rows, and the rows' keys. */
async function reconcile(orgId: string, key: string, dimensionId: string | null) {
  const snap = await snapshot(orgId, key, dimensionId);
  expect(snap, `${key} snapshot`).not.toBeNull();
  expect(snap!.basis).toBe('bank');
  expect(snap!.descriptor, `${key} must carry a descriptor`).not.toBeNull();
  const selection = await resolveDescriptor(ctxFor(orgId), snap!.descriptor);
  expect(selection.count).toBe(selection.rows.length);
  // Independent sum: the figure is spend-positive for suppliers, so outflow rows count as magnitudes.
  const independent = selection.rows.reduce(
    (sum, r) => sum.plus(key === 'supplier_spend' ? new Decimal(r.amount!).abs() : new Decimal(r.amount!)),
    new Decimal(0),
  );
  const byId = new Map([...txn.entries()].map(([k, id]) => [id, k]));
  return {
    figure: new Decimal(snap!.value!).toFixed(2),
    evidenceTotal: new Decimal(selection.total!).toFixed(2),
    independent: independent.toFixed(2),
    keys: selection.rows.map((r) => byId.get(r.id) ?? `?${r.id}`).sort(),
    rows: selection.rows,
    snapshotId: snap!.snapshotId,
  };
}

describe('CASE A — bank-basis supplier spend is expense-category, non-transfer outflows', () => {
  it('Supplier One: figure = evidence = the two expense payments, nothing else', async () => {
    const r = await reconcile(org, 'supplier_spend', party.get('Supplier One')!);
    expect(r.keys).toEqual(['S1 RENT', 'S1 STOCK']);
    expect(r.figure).toBe('4350.00');
    expect(r.evidenceTotal).toBe(r.figure);
    expect(r.independent).toBe(r.figure);
  });

  it('excludes transfers, inflows, uncategorised rows and non-P&L categories from the evidence', async () => {
    const r = await reconcile(org, 'supplier_spend', party.get('Supplier One')!);
    expect(r.rows.map((row) => row.transferKind)).toEqual(['none', 'none']);
    // The drawer shows a directional selection as magnitudes (ADR-109); the stored rows are outflows.
    const raw = await Promise.all(r.rows.map(async (row) => String((await rowOf(org, 'bank_transactions', row.id))!.amount)));
    expect(raw.map((v) => new Decimal(v).isNegative())).toEqual([true, true]);
    for (const excluded of ['S1 UNCATEGORISED OUT', 'S1 LOAN REPAYMENT', 'S1 CARD REPAYMENT (expense-categorised)', 'S1 CARD REPAYMENT IN']) {
      expect(r.keys).not.toContain(excluded);
    }
  });

  it('a supplier refund (expense-categorised inflow) and drawings are not spend', async () => {
    const r = await reconcile(org, 'supplier_spend', party.get('Supplier Two')!);
    expect(r.keys).toEqual(['S2 ADS']);
    expect(r.figure).toBe('900.00');
    expect(r.evidenceTotal).toBe(r.figure);
  });
});

describe('the bank-basis P&L expense lines follow the same rule', () => {
  it('an expense category is its non-transfer outflows, and its evidence totals the same positive figure', async () => {
    const line = async (category: string) => {
      const cell = (await orgCollection(fs(), org, 'metric_current').where('metric_key', '==', 'expense_by_category')
        .where('dimension_key', '==', category).where('period_id', '==', await periodFor(org, '2026-08-01')).limit(1).get()).docs[0]!;
      const s = (await rowOf(org, 'metric_snapshots', String(cell.get('snapshot_id'))))!;
      return { value: String(s.value), query: s.evidence_query as { descriptor: unknown } };
    };
    const byId = new Map([...txn.entries()].map(([k, id]) => [id, k]));
    for (const [category, keys, figure] of [
      // Rent and the unnamed expense; the card repayment leg is a transfer, the card-side leg an inflow.
      ['operating_expense', ['S1 RENT', 'UNNAMED EXPENSE'], '1850.00'],
      // The supplier refund (an inflow) enters no figure.
      ['marketing', ['S2 ADS'], '900.00'],
    ] as const) {
      const { value, query } = await line(category);
      const selection = await resolveDescriptor(ctxFor(org), query.descriptor);
      expect(new Decimal(value).toFixed(2), category).toBe(figure);
      expect(new Decimal(selection.total!).toFixed(2), category).toBe(figure);
      expect(selection.rows.map((r) => byId.get(r.id)).sort(), category).toEqual([...keys]);
    }
  });
});

describe('CASE B — bank-basis customer revenue is revenue-category, non-transfer inflows', () => {
  it('Customer One: the two receipts; the refund, uncategorised and other income are excluded', async () => {
    const r = await reconcile(org, 'customer_revenue', party.get('Customer One')!);
    expect(r.keys).toEqual(['C1 SALE A', 'C1 SALE B']);
    expect(r.figure).toBe('12500.00');
    expect(r.evidenceTotal).toBe(r.figure);
    expect(r.independent).toBe(r.figure);
  });

  it('Customer Two: a revenue-categorised transfer leg and owner funding are not revenue', async () => {
    const r = await reconcile(org, 'customer_revenue', party.get('Customer Two')!);
    expect(r.keys).toEqual(['C2 SALE']);
    expect(r.figure).toBe('4000.00');
    expect(r.evidenceTotal).toBe(r.figure);
    expect(r.rows.some((row) => row.transferKind !== null && row.transferKind !== 'none')).toBe(false);
  });

  it('the bank-basis revenue line excludes the transfer leg too, and Σ customers + Unattributed = revenue', async () => {
    const revenue = await reconcile(org, 'revenue', null);
    // §4.4: revenue-category inflows, no transfer. The refund is on the other side and enters no figure.
    expect(revenue.keys).toEqual(['C1 SALE A', 'C1 SALE B', 'C2 SALE', 'UNNAMED SALE']);
    expect(revenue.figure).toBe('17700.00');
    expect(revenue.evidenceTotal).toBe(revenue.figure);
    const unattributed = (await snapshot(org, 'customer_revenue', null))!;
    // The remainder is the one revenue inflow with no party — not a transfer, not a refund.
    expect(new Decimal(unattributed.value!).toFixed(2)).toBe('1200.00');
    expect(unattributed.descriptor).toBeNull();
  });
});

describe('CASE C — the HIGH-3 shape: a party with only uncategorised and transfer rows', () => {
  it('has no spend and no revenue to show, rather than a figure over an empty drill-down', async () => {
    // Old implementation: Supplier Three = 4,100 + 2,020 + 2,020 = 8,140.00 over 0 evidence rows.
    expect(await snapshot(org, 'supplier_spend', party.get('Supplier Three')!)).toBeNull();
    expect(await snapshot(org, 'customer_revenue', party.get('Customer Three')!)).toBeNull();
  });
});

describe('CASE D — every counterparty snapshot on the organisation reconciles', () => {
  it('each attributed customer_revenue and supplier_spend figure equals its evidence', async () => {
    const ids = (await rowsOf(org, 'metric_current'))
      .filter((c) => (c.metric_key === 'customer_revenue' || c.metric_key === 'supplier_spend') && c.dimension_id !== null)
      .map((c) => `${c.metric_key}|${c.dimension_id}`);
    expect(ids.sort()).toEqual([
      `customer_revenue|${party.get('Customer One')}`, `customer_revenue|${party.get('Customer Two')}`,
      `supplier_spend|${party.get('Supplier One')}`, `supplier_spend|${party.get('Supplier Two')}`,
    ].sort());
    for (const line of ids) {
      const [key, dim] = line.split('|');
      const r = await reconcile(org, key!, dim!);
      expect(r.evidenceTotal, `${key} ${dim}`).toBe(r.figure);
      expect(r.independent, `${key} ${dim}`).toBe(r.figure);
    }
    const supplierUnattributed = (await snapshot(org, 'supplier_spend', null))!;
    expect(new Decimal(supplierUnattributed.value!).toFixed(2)).toBe('700.00');
    expect(supplierUnattributed.descriptor).toBeNull();
  });
});

describe('CASE E — no eligible commercial rows', () => {
  it('writes no attributed figure, fabricates no evidence, and keeps the covered zero as zero', async () => {
    const attributed = (await rowsOf(emptyOrg, 'metric_current'))
      .filter((c) => (c.metric_key === 'customer_revenue' || c.metric_key === 'supplier_spend') && c.dimension_id !== null);
    expect(attributed).toHaveLength(0);
    // The bank covers the period, so revenue is a known zero, not missing (ADR-104) …
    const revenue = (await snapshot(emptyOrg, 'revenue', null))!;
    expect(new Decimal(revenue.value!).toFixed(2)).toBe('0.00');
    // … and the Unattributed rows are that zero with no descriptor: nothing to drill into, nothing invented.
    for (const key of ['customer_revenue', 'supplier_spend']) {
      const row = (await snapshot(emptyOrg, key, null))!;
      expect(new Decimal(row.value!).toFixed(2)).toBe('0.00');
      expect(row.descriptor).toBeNull();
    }
  });
});

describe('the analyst reads the same population', () => {
  async function callContext(orgId: string) {
    const rows = await loadPeriods(clientFor(owner), orgId, `itest-${RUN}`);
    const withData = await loadPeriodsWithData(clientFor(owner), orgId, `itest-${RUN}`);
    const periodContext = resolvePeriodContext({
      question: 'how did Aug 2026 go?', fiscalYearStartMonth: 1,
      periods: rows.map((p) => ({ id: p.id, label: p.label, periodStart: p.periodStart, isComplete: p.isComplete, hasData: withData.has(p.id) })),
    });
    // August is the month under test; naming it as known is how an earlier tool result would.
    const august = rows.find((p) => p.periodStart === '2026-08-01')!;
    return { ctx: ctxFor(orgId), periodContext, knownPeriods: [{ id: august.id, label: august.label }], now: new Date('2026-09-15T00:00:00Z') };
  }
  const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

  it('get_customer_profitability states the corrected figures', async () => {
    const august = (await loadPeriods(clientFor(owner), org, `itest-${RUN}`)).find((p) => p.periodStart === '2026-08-01')!;
    const out = await tool('get_customer_profitability').run({ period: august.label }, await callContext(org)) as {
      ok: boolean; data: { rows: Array<{ subject: { id: string }; revenue: { value: string } }> };
    };
    expect(out.ok, JSON.stringify(out).slice(0, 400)).toBe(true);
    const byId = new Map(out.data.rows.map((r) => [r.subject.id, new Decimal(r.revenue.value).toFixed(2)]));
    expect(byId.get(party.get('Customer One')!)).toBe('12500.00');
    expect(byId.get(party.get('Customer Two')!)).toBe('4000.00');
    expect(byId.has(party.get('Customer Three')!)).toBe(false);
  });

  it('get_transactions_for_evidence cites only the eligible rows, and they sum to the figure', async () => {
    for (const [key, name, expected, total] of [
      ['supplier_spend', 'Supplier One', ['S1 RENT', 'S1 STOCK'], '4350.00'],
      ['customer_revenue', 'Customer Two', ['C2 SALE'], '4000.00'],
    ] as const) {
      const snap = (await snapshot(org, key, party.get(name)!))!;
      const out = await tool('get_transactions_for_evidence').run({ metric_snapshot_id: snap.snapshotId }, await callContext(org)) as {
        ok: boolean; data: { records: Array<{ id: string; amount: { value: string } }> };
      };
      expect(out.ok, `${key} ${name}`).toBe(true);
      const byId = new Map([...txn.entries()].map(([k, id]) => [id, k]));
      expect(out.data.records.map((r) => byId.get(r.id)).sort()).toEqual([...expected]);
      const sum = out.data.records.reduce((s, r) => s.plus(new Decimal(r.amount.value).abs()), new Decimal(0));
      expect(sum.toFixed(2)).toBe(total);
    }
  });
});
