import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolvePeriodContext, TOOLS } from '@/modules/ai';
import { loadPeriods, loadPeriodsWithData } from '@/modules/dashboard';
import { resolveDescriptor } from '@/modules/evidence';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { writeRecordStatusEvent } from '@/db/app/shared';
import { orgCollection } from '@/db/schema';
import { clientFor, createAuthUser, drainUntilFinished, fs } from './setup';
import {
  dropFixtures, makeOrg, periodFor, queueCalculation, rowOf, rowsOf, seedBatch, seedCounterparty, seedDocument,
  seedImportRow, seedLedgerEntry, systemAccount,
} from './f-fixtures';

/**
 * HIGH-5 and HIGH-6: on the ledger basis, a counterparty's figure and its evidence are one population,
 * totalled in one sign (ADR-111).
 *
 * HIGH-5: the figure was Σ|cell| over every non-revenue ledger cell for the party. A general-ledger
 * export prints the contact on every line of a journal, so a supplier's payables and bank lines
 * counted as spend: 11,300.00 over a drill-down of 6,100.00.
 *
 * HIGH-6: a ledger descriptor was totalled on `ledger_entries.amount`, which is stored positive with
 * the side in `direction`, so a refund was ADDED to the drill-down of the revenue it reduces:
 * `revenue` 19,400.00 over 21,400.00.
 *
 * The test drives rows → `calculation.run` → snapshot → descriptor → the evidence service under the
 * owner's read policies → an independent reporting-sign sum of the rows, and checks the rows themselves.
 */

vi.setConfig({ testTimeout: 180_000 });

const RUN = `lc${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.ledgercommercial.itest.motion`;

let owner: string;
let org: string;
let emptyOrg: string;
const party = new Map<string, string>();
const line = new Map<string, string>();

const ctxFor = (orgId: string): AccessContext => ({
  userId: owner, orgId, orgSlug: 'lc', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(owner), requestId: `itest-${RUN}`,
  now: () => new Date('2026-09-15T00:00:00Z'), organizationStatus: 'active',
});

const createOrg = (name: string): Promise<string> => makeOrg(owner, name);

async function calc(orgId: string) {
  const j = await queueCalculation(orgId, { trigger: 'recalc_manual', as_of: '2026-09-15' });
  expect(await drainUntilFinished(drainJobs, j, 60)).toBe('succeeded');
}

/** A ledger organisation with a general-ledger batch; returns a line writer. */
async function ledgerOrg(orgId: string) {
  const accounts = new Map<string, string>();
  const acct = async (cat: string) => {
    if (!accounts.has(cat)) accounts.set(cat, await systemAccount(orgId, cat));
    return accounts.get(cat)!;
  };
  const doc = await seedDocument(orgId, { filename: 'g.csv', kind: 'general_ledger' });
  const batch = await seedBatch(orgId, {
    documentId: doc, importType: 'general_ledger', targetTable: 'ledger_entries', status: 'committed',
    periodStart: '2026-08-01', periodEnd: '2026-08-31',
  });
  let n = 0;
  return async (key: string, cat: string, dir: 'debit' | 'credit', amount: string, who: string | null) => {
    n += 1;
    const row = await seedImportRow(orgId, { batchId: batch, rowNumber: n, status: 'committed', sourceRef: `r${n}` });
    const id = await seedLedgerEntry(orgId, {
      accountId: await acct(cat), date: `2026-08-${String(10 + (n % 15)).padStart(2, '0')}`, direction: dir, amount,
      sourceDocumentId: doc, importBatchId: batch, importRowId: row, sourceRef: `r${n}`, counterpartyId: who, description: key,
    });
    await fs().runTransaction(async (t) => {
      writeRecordStatusEvent(t, fs(), { orgId, table: 'ledger_entries', recordId: id, event: 'accepted', actorId: null, batchId: batch });
    });
    line.set(key, id);
    return id;
  };
}

const cp = async (orgId: string, name: string, kind: string) => {
  const id = await seedCounterparty(orgId, { name, kind });
  party.set(name, id);
  return id;
};

beforeAll(async () => {
  owner = await createAuthUser(`owner@${DOMAIN}`);
  org = await createOrg(`LC ${RUN}`);
  const e = await ledgerOrg(org);
  const C1 = await cp(org, 'Customer One', 'customer');
  const C2 = await cp(org, 'Customer Two', 'customer');
  const S1 = await cp(org, 'Supplier One', 'supplier');
  const S2 = await cp(org, 'Supplier Two', 'supplier');

  // ---- Customers: sales, a refund, other income, and the contact on the receivable and bank lines ----
  await e('C1 SALE', 'revenue', 'credit', '18000.00', C1);
  await e('C1 SALE RECEIVABLE', 'receivables', 'debit', '18000.00', C1);
  await e('C1 REFUND', 'revenue', 'debit', '1000.00', C1);
  await e('C1 RECEIPT BANK', 'cash', 'debit', '17000.00', C1);
  await e('C1 RECEIPT RECEIVABLE', 'receivables', 'credit', '17000.00', C1);
  await e('C1 OTHER INCOME', 'other_income', 'credit', '700.00', C1);
  await e('C2 SALE', 'revenue', 'credit', '6000.00', C2);
  await e('UNNAMED SALE', 'revenue', 'credit', '2400.00', null);

  // ---- Suppliers: expenses, a supplier credit, and the contact on the payables and bank lines ----
  await e('S1 STOCK', 'cost_of_sales', 'debit', '5200.00', S1);
  await e('S1 STOCK PAYABLE', 'payables', 'credit', '5200.00', S1);
  await e('S1 PAYMENT PAYABLE', 'payables', 'debit', '5200.00', S1);
  await e('S1 PAYMENT BANK', 'cash', 'credit', '5200.00', S1);
  await e('S1 ADS', 'marketing', 'debit', '900.00', S1);
  await e('S1 CREDIT NOTE', 'cost_of_sales', 'credit', '300.00', S1);
  await e('S1 LOAN REPAYMENT', 'loan', 'debit', '1500.00', S1);
  await e('S2 RENT', 'operating_expense', 'debit', '1250.00', S2);
  await e('S2 DRAWINGS', 'drawings', 'debit', '400.00', S2);
  await e('UNNAMED PAYROLL', 'payroll', 'debit', '4300.00', null);
  await calc(org);

  // ---- An organisation whose ledger names parties only on balance-sheet lines ----
  emptyOrg = await createOrg(`LC empty ${RUN}`);
  const z = await ledgerOrg(emptyOrg);
  const zS = await cp(emptyOrg, 'Only Payables', 'supplier');
  await z('Z SALE', 'revenue', 'credit', '800.00', null);
  await z('Z PAYABLE', 'payables', 'credit', '650.00', zS);
  await z('Z BANK', 'cash', 'credit', '650.00', zS);
  await calc(emptyOrg);
}, 900_000);

afterAll(async () => {
  await dropFixtures([org, emptyOrg], DOMAIN);
}, 60_000);

interface Snap { snapshotId: string; value: string | null; basis: string; descriptor: unknown }

async function snapshot(orgId: string, key: string, dimension: { id?: string | null; key?: string }): Promise<Snap | null> {
  let q: FirebaseFirestore.Query = orgCollection(fs(), orgId, 'metric_current')
    .where('metric_key', '==', key).where('period_id', '==', await periodFor(orgId, '2026-08-01'));
  q = dimension.key !== undefined
    ? q.where('dimension_key', '==', dimension.key)
    : dimension.id === null || dimension.id === undefined
      ? q.where('dimension_id', '==', null).where('dimension_type', '==', key === 'customer_revenue' || key === 'supplier_spend' ? 'counterparty' : 'none')
      : q.where('dimension_id', '==', dimension.id);
  const cell = (await q.limit(1).get()).docs[0];
  if (!cell) return null;
  const s = (await rowOf(orgId, 'metric_snapshots', String(cell.get('snapshot_id'))))!;
  // LOW-13: "no descriptor" is stored as a null query.
  const query = (s.evidence_query ?? null) as { descriptor?: unknown } | null;
  return {
    snapshotId: String(s.id), value: s.value === null || s.value === undefined ? null : String(s.value), basis: String(s.basis),
    descriptor: query?.descriptor ?? null,
  };
}

/** Figure, evidence total, an independent reporting-sign Σ of the returned rows, and their keys. */
async function reconcile(orgId: string, key: string, dimension: { id?: string | null; key?: string }, sign: 'income' | 'expense') {
  const snap = await snapshot(orgId, key, dimension);
  expect(snap, `${key} snapshot`).not.toBeNull();
  expect(snap!.basis).toBe('ledger');
  expect(snap!.descriptor, `${key} must carry a descriptor`).not.toBeNull();
  const selection = await resolveDescriptor(ctxFor(orgId), snap!.descriptor);
  expect(selection.count).toBe(selection.rows.length);
  // Independently of the evidence service's amounts: re-read each line's stored side and amount.
  const raw = await Promise.all(selection.rows.map(async (r) => (await rowOf(orgId, 'ledger_entries', r.id))!));
  const independent = raw.reduce((total, l) => {
    const credit = l.direction === 'credit';
    return total.plus(new Decimal(String(l.amount)).times((sign === 'income') === credit ? 1 : -1));
  }, new Decimal(0));
  const byId = new Map([...line.entries()].map(([k, id]) => [id, k]));
  return {
    figure: new Decimal(snap!.value!).toFixed(2),
    evidenceTotal: new Decimal(selection.total!).toFixed(2),
    independent: independent.toFixed(2),
    keys: selection.rows.map((r) => byId.get(r.id) ?? `?${r.id}`).sort(),
    snapshotId: snap!.snapshotId,
  };
}

describe('HIGH-5 — ledger supplier spend is the party\'s expense lines, net of credits', () => {
  it('Supplier One: stock, ads and the credit note — never its payables, bank or loan lines', async () => {
    const r = await reconcile(org, 'supplier_spend', { id: party.get('Supplier One')! }, 'expense');
    expect(r.keys).toEqual(['S1 ADS', 'S1 CREDIT NOTE', 'S1 STOCK']);
    // Old figure: 5,200 − 300 + 900 + |payables 0| + |bank 5,200| + |loan 1,500| = 12,500.00.
    expect(r.figure).toBe('5800.00');
    expect(r.evidenceTotal).toBe(r.figure);
    expect(r.independent).toBe(r.figure);
  });

  it('Supplier Two: rent, not drawings', async () => {
    const r = await reconcile(org, 'supplier_spend', { id: party.get('Supplier Two')! }, 'expense');
    expect(r.keys).toEqual(['S2 RENT']);
    expect(r.figure).toBe('1250.00');
    expect(r.evidenceTotal).toBe(r.figure);
  });

  it('a party named only on balance-sheet lines has no spend at all', async () => {
    // Old figure: |payables 650| + |bank 650| = 1,300.00 of "spend" over an empty drill-down.
    expect(await snapshot(emptyOrg, 'supplier_spend', { id: party.get('Only Payables')! })).toBeNull();
    const attributed = (await rowsOf(emptyOrg, 'metric_current'))
      .filter((c) => (c.metric_key === 'customer_revenue' || c.metric_key === 'supplier_spend') && c.dimension_id !== null);
    expect(attributed).toHaveLength(0);
  });
});

describe('HIGH-5 — ledger customer revenue is the party\'s revenue lines, net of refunds', () => {
  it('Customer One: the sale less the refund — not other income, the receivable or the bank line', async () => {
    const r = await reconcile(org, 'customer_revenue', { id: party.get('Customer One')! }, 'income');
    expect(r.keys).toEqual(['C1 REFUND', 'C1 SALE']);
    expect(r.figure).toBe('17000.00');
    expect(r.evidenceTotal).toBe(r.figure);
    expect(r.independent).toBe(r.figure);
  });

  it('Σ customers + Unattributed = revenue, and Unattributed is the unnamed sale', async () => {
    const c2 = await reconcile(org, 'customer_revenue', { id: party.get('Customer Two')! }, 'income');
    expect(c2.figure).toBe('6000.00');
    const unattributed = (await snapshot(org, 'customer_revenue', { id: null }))!;
    expect(new Decimal(unattributed.value!).toFixed(2)).toBe('2400.00');
    expect(unattributed.descriptor).toBeNull();
    const revenue = (await snapshot(org, 'revenue', { id: null }))!;
    expect(new Decimal(revenue.value!).toFixed(2)).toBe('25400.00');
  });
});

describe('HIGH-6 — a ledger drill-down is totalled in reporting sign', () => {
  it('revenue: the refund subtracts in the evidence exactly as in the figure', async () => {
    const r = await reconcile(org, 'revenue', { id: null }, 'income');
    expect(r.keys).toEqual(['C1 REFUND', 'C1 SALE', 'C2 SALE', 'UNNAMED SALE']);
    // Old evidence total: 18,000 + 1,000 + 6,000 + 2,400 = 27,400.00.
    expect(r.figure).toBe('25400.00');
    expect(r.evidenceTotal).toBe(r.figure);
    expect(r.independent).toBe(r.figure);
  });

  it('an expense category: the supplier credit subtracts', async () => {
    const r = await reconcile(org, 'expense_by_category', { key: 'cost_of_sales' }, 'expense');
    expect(r.keys).toEqual(['S1 CREDIT NOTE', 'S1 STOCK']);
    expect(r.figure).toBe('4900.00');
    expect(r.evidenceTotal).toBe(r.figure);
  });

  it('every leaf descriptor on the organisation reconciles', async () => {
    const rows: Array<{ key: string; value: string | null; descriptor: unknown }> = [];
    for (const c of await rowsOf(org, 'metric_current')) {
      const s = await rowOf(org, 'metric_snapshots', String(c.snapshot_id));
      const q = (s?.evidence_query ?? null) as { kind?: string; descriptor?: unknown } | null;
      if (s && q && q.kind === 'leaf') rows.push({ key: String(c.metric_key), value: s.value === null ? null : String(s.value), descriptor: q.descriptor });
    }
    expect(rows.length).toBeGreaterThan(10);
    const mismatches: string[] = [];
    for (const { key, value, descriptor } of rows) {
      const selection = await resolveDescriptor(ctxFor(org), descriptor);
      const fig = value === null ? 'NULL' : new Decimal(value).toFixed(2);
      const tot = selection.total === null ? 'NULL' : new Decimal(selection.total).toFixed(2);
      if (fig !== tot) mismatches.push(`${key} figure=${fig} evidence=${tot}`);
    }
    expect(mismatches).toEqual([]);
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
    expect(byId.get(party.get('Customer One')!)).toBe('17000.00');
    expect(byId.get(party.get('Customer Two')!)).toBe('6000.00');
  });

  it('get_transactions_for_evidence cites only the population, and its sum is the figure', async () => {
    const byId = new Map([...line.entries()].map(([k, id]) => [id, k]));
    for (const [key, name, expected, total] of [
      ['supplier_spend', 'Supplier One', ['S1 ADS', 'S1 CREDIT NOTE', 'S1 STOCK'], '5800.00'],
      ['customer_revenue', 'Customer One', ['C1 REFUND', 'C1 SALE'], '17000.00'],
    ] as const) {
      const snap = (await snapshot(org, key, { id: party.get(name)! }))!;
      const out = await tool('get_transactions_for_evidence').run({ metric_snapshot_id: snap.snapshotId }, await callContext(org)) as {
        ok: boolean; data: { records: Array<{ id: string; amount: { value: string } }>; sum: { value: string } | null };
      };
      expect(out.ok, `${key} ${name}`).toBe(true);
      expect(out.data.records.map((r) => byId.get(r.id)).sort()).toEqual([...expected]);
      // Each record now carries its reporting-sign amount, so the records add up to the figure.
      const sum = out.data.records.reduce((s, r) => s.plus(new Decimal(r.amount.value)), new Decimal(0));
      expect(sum.toFixed(2)).toBe(total);
    }
  });
});
