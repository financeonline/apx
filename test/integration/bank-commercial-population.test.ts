import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolvePeriodContext, TOOLS } from '@/modules/ai';
import { loadPeriods, loadPeriodsWithData } from '@/modules/dashboard';
import { resolveDescriptor } from '@/modules/evidence';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

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
 * service under the owner's RLS → an independent sum of the rows it returned — and checks the rows
 * themselves, not only the totals, so a population that happened to add up to the right number over
 * the wrong rows still fails.
 *
 * The commercial rows are categorised by the USER, because the banking pass re-derives `rule`
 * categories and would otherwise decide the population before the engine sees it.
 */

const RUN = `bc${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.bankcommercial.itest`;
const one = (s: string) => adminSql(`with q as (${s}) select * from q`).trim();

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

async function createOrg(name: string): Promise<string> {
  const r = await clientFor(owner).schema('api').rpc('create_organization', { p_name: name });
  if (r.error) throw new Error(r.error.message);
  return r.data as unknown as string;
}

async function calc(orgId: string) {
  const j = adminSql(`insert into public.jobs (organization_id, job_type, payload, max_attempts) values ('${orgId}','calculation.run','{"trigger":"recalc_manual","as_of":"2026-09-15"}'::jsonb,3) returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, j)).toBe('succeeded');
}

/** A bank organisation with a statement batch; returns a row writer. */
function bankOrg(orgId: string) {
  const acct = (cat: string) => one(`select id from public.accounts where organization_id='${orgId}' and standard_category='${cat}' and is_system limit 1`);
  const bank = (name: string, type: string) => one(`insert into public.bank_accounts (organization_id, name, bank_name, account_type, opening_balance, opening_balance_date, is_active) values ('${orgId}','${name}','Test Bank','${type}',0,'2026-08-01',true) returning id`);
  const main = bank('Main', 'current');
  const savings = bank('Savings', 'savings');
  const card = bank('Card', 'credit_card');
  const doc = one(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind) values ('${orgId}','${orgId}/b.csv','b.csv','text/csv',10,digest('${orgId}b','sha256'),'ready','bank_statement') returning id`);
  const batch = one(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at, bank_account_id) values ('${orgId}','${doc}','bank_statement','bank_transactions','committed','csv','2026-08-01','2026-08-31',now(),'${main}') returning id`);
  let n = 0;
  const tx = (o: {
    key: string; bank: string; amount: string; party: string | null; cat: string | null; kind?: string;
  }) => {
    n += 1;
    const kind = o.kind ?? 'none';
    const row = one(`insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status) values ('${orgId}','${batch}',${n},'t${n}','{}'::jsonb,'{}'::jsonb,'committed') returning id`);
    const id = one(`insert into public.bank_transactions (organization_id, bank_account_id, transaction_date, amount, currency, description_raw, description_normalized, period_id, category_source, record_status, assurance_level, duplicate_reviewed, source_document_id, import_batch_id, import_row_id, source_ref, counterparty_id, category_account_id, is_transfer, transfer_kind)
      values ('${orgId}','${o.bank}','2026-08-${String(10 + (n % 15)).padStart(2, '0')}',${o.amount},'GBP','${o.key}','${o.key}','00000000-0000-0000-0000-000000000000','${o.cat === null ? 'none' : 'user'}','accepted','verified',true,'${doc}','${batch}','${row}','t${n}',${o.party === null ? 'null' : `'${o.party}'`},${o.cat === null ? 'null' : `'${acct(o.cat)}'`},${kind !== 'none'},'${kind}') returning id`);
    adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id) values ('${orgId}','bank_transactions','${id}','accepted','${batch}')`);
    txn.set(o.key, id);
    return id;
  };
  const pair = (a: string, b: string) => adminSql(`update public.bank_transactions set transfer_pair_id = case id when '${a}' then '${b}'::uuid else '${a}'::uuid end where id in ('${a}','${b}')`);
  return { main, savings, card, tx, pair };
}

const cp = (orgId: string, name: string, kind: string) => {
  const id = one(`insert into public.counterparties (organization_id, name, kind) values ('${orgId}','${name}','${kind}') returning id`);
  party.set(name, id);
  return id;
};

beforeAll(async () => {
  owner = createAuthUser(`owner@${DOMAIN}`);
  org = await createOrg(`BC ${RUN}`);
  const b = bankOrg(org);
  const C1 = cp(org, 'Customer One', 'customer');
  const C2 = cp(org, 'Customer Two', 'customer');
  const C3 = cp(org, 'Customer Three', 'customer');
  const S1 = cp(org, 'Supplier One', 'supplier');
  const S2 = cp(org, 'Supplier Two', 'supplier');
  const S3 = cp(org, 'Supplier Three', 'supplier');

  // ---- CASE B: customer revenue ----
  b.tx({ key: 'C1 SALE A', bank: b.main, amount: '10000.00', party: C1, cat: 'revenue' });
  b.tx({ key: 'C1 SALE B', bank: b.main, amount: '2500.00', party: C1, cat: 'revenue' });
  b.tx({ key: 'C1 REFUND', bank: b.main, amount: '-400.00', party: C1, cat: 'revenue' });
  b.tx({ key: 'C1 UNCATEGORISED IN', bank: b.main, amount: '1300.00', party: C1, cat: null });
  b.tx({ key: 'C1 OTHER INCOME', bank: b.main, amount: '700.00', party: C1, cat: 'other_income' });
  b.tx({ key: 'C2 SALE', bank: b.main, amount: '4000.00', party: C2, cat: 'revenue' });
  b.tx({ key: 'C2 OWNER FUNDING', bank: b.main, amount: '5000.00', party: C2, cat: 'equity' });
  // A cash transfer whose incoming leg still carries a revenue category, as a hand-marked pair does.
  const tIn = b.tx({ key: 'C2 TRANSFER IN (revenue-categorised)', bank: b.main, amount: '3000.00', party: C2, cat: 'revenue', kind: 'cash_transfer' });
  const tOut = b.tx({ key: 'C2 TRANSFER OUT', bank: b.savings, amount: '-3000.00', party: C2, cat: 'transfer', kind: 'cash_transfer' });
  b.pair(tIn, tOut);
  b.tx({ key: 'UNNAMED SALE', bank: b.main, amount: '1200.00', party: null, cat: 'revenue' });

  // ---- CASE A: supplier spend ----
  b.tx({ key: 'S1 STOCK', bank: b.main, amount: '-3200.00', party: S1, cat: 'cost_of_sales' });
  b.tx({ key: 'S1 RENT', bank: b.main, amount: '-1150.00', party: S1, cat: 'operating_expense' });
  b.tx({ key: 'S1 UNCATEGORISED OUT', bank: b.main, amount: '-2750.00', party: S1, cat: null });
  b.tx({ key: 'S1 LOAN REPAYMENT', bank: b.main, amount: '-500.00', party: S1, cat: 'loan' });
  // A card repayment whose paying leg still carries an expense category.
  const rOut = b.tx({ key: 'S1 CARD REPAYMENT (expense-categorised)', bank: b.main, amount: '-1800.00', party: S1, cat: 'operating_expense', kind: 'card_repayment' });
  const rIn = b.tx({ key: 'S1 CARD REPAYMENT IN', bank: b.card, amount: '1800.00', party: S1, cat: 'operating_expense', kind: 'card_repayment' });
  b.pair(rOut, rIn);
  b.tx({ key: 'S2 ADS', bank: b.main, amount: '-900.00', party: S2, cat: 'marketing' });
  b.tx({ key: 'S2 REFUND IN', bank: b.main, amount: '250.00', party: S2, cat: 'marketing' });
  b.tx({ key: 'S2 DRAWINGS', bank: b.main, amount: '-600.00', party: S2, cat: 'drawings' });
  b.tx({ key: 'UNNAMED EXPENSE', bank: b.main, amount: '-700.00', party: null, cat: 'operating_expense' });

  // ---- CASE C: the HIGH-3 shape — a party whose only rows are uncategorised or transfers ----
  b.tx({ key: 'S3 UNCATEGORISED', bank: b.main, amount: '-4100.00', party: S3, cat: null });
  const s3Out = b.tx({ key: 'S3 TRANSFER OUT', bank: b.main, amount: '-2020.00', party: S3, cat: 'transfer', kind: 'cash_transfer' });
  const s3In = b.tx({ key: 'S3 TRANSFER IN', bank: b.savings, amount: '2020.00', party: S3, cat: 'transfer', kind: 'cash_transfer' });
  b.pair(s3Out, s3In);
  b.tx({ key: 'C3 UNCATEGORISED IN', bank: b.main, amount: '2600.00', party: C3, cat: null });
  await calc(org);

  // ---- CASE E: a bank organisation with no eligible commercial row at all ----
  emptyOrg = await createOrg(`BC empty ${RUN}`);
  const e = bankOrg(emptyOrg);
  const eS = cp(emptyOrg, 'Empty Supplier', 'supplier');
  const eC = cp(emptyOrg, 'Empty Customer', 'customer');
  e.tx({ key: 'E UNCATEGORISED OUT', bank: e.main, amount: '-1500.00', party: eS, cat: null });
  e.tx({ key: 'E UNCATEGORISED IN', bank: e.main, amount: '800.00', party: eC, cat: null });
  const eOut = e.tx({ key: 'E TRANSFER OUT', bank: e.main, amount: '-400.00', party: eS, cat: 'transfer', kind: 'cash_transfer' });
  const eIn = e.tx({ key: 'E TRANSFER IN', bank: e.savings, amount: '400.00', party: eS, cat: 'transfer', kind: 'cash_transfer' });
  e.pair(eOut, eIn);
  await calc(emptyOrg);
}, 900_000);

afterAll(() => { if (process.env.KEEP_BC) return;
  adminSql(`delete from public.organizations where id in ('${org}','${emptyOrg}'); delete from auth.users where email like '%@${DOMAIN}';`);
});

interface Snap { snapshotId: string; value: string | null; basis: string; descriptor: unknown }

function snapshot(orgId: string, key: string, dimensionId: string | null): Snap | null {
  const line = adminSql(`select s.id || '|' || coalesce(s.value::text,'NULL') || '|' || s.basis || '|' || coalesce(s.evidence_query::text,'NULL')
      from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id
      join public.fiscal_periods p on p.id = c.period_id
     where c.organization_id = '${orgId}' and c.metric_key = '${key}' and p.period_start = '2026-08-01'
       and ${dimensionId === null ? `c.dimension_id is null and c.dimension_type = ${key === 'revenue' ? `'none'` : `'counterparty'`}` : `c.dimension_id = '${dimensionId}'`}`).trim();
  if (line === '') return null;
  const [snapshotId, value, basis, ...rest] = line.split('|');
  const query = rest.join('|');
  return {
    snapshotId: snapshotId!, value: value === 'NULL' ? null : value!, basis: basis!,
    // The Unattributed rows store a JSON `null` query, which `coalesce` does not catch.
    descriptor: query === 'NULL' ? null : (JSON.parse(query) as { descriptor?: unknown } | null)?.descriptor ?? null,
  };
}

/** Figure, evidence total, independent Σ of the returned rows, and the rows' keys. */
async function reconcile(orgId: string, key: string, dimensionId: string | null) {
  const snap = snapshot(orgId, key, dimensionId);
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
    const raw = adminSql(`select amount from public.bank_transactions where id in (${r.rows.map((row) => `'${row.id}'`).join(',')})`)
      .split('\n').map((l) => l.trim()).filter(Boolean);
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
    const line = (category: string) => adminSql(`select s.value || '|' || s.evidence_query::text
        from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id
        join public.fiscal_periods p on p.id = c.period_id
       where c.organization_id = '${org}' and c.metric_key = 'expense_by_category' and c.dimension_key = '${category}'
         and p.period_start = '2026-08-01'`).trim();
    const byId = new Map([...txn.entries()].map(([k, id]) => [id, k]));
    for (const [category, keys, figure] of [
      // Rent and the unnamed expense; the card repayment leg is a transfer, the card-side leg an inflow.
      ['operating_expense', ['S1 RENT', 'UNNAMED EXPENSE'], '1850.00'],
      // The supplier refund (an inflow) enters no figure.
      ['marketing', ['S2 ADS'], '900.00'],
    ] as const) {
      const [value, ...rest] = line(category).split('|');
      const selection = await resolveDescriptor(ctxFor(org), (JSON.parse(rest.join('|')) as { descriptor: unknown }).descriptor);
      expect(new Decimal(value!).toFixed(2), category).toBe(figure);
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
    const unattributed = snapshot(org, 'customer_revenue', null)!;
    // The remainder is the one revenue inflow with no party — not a transfer, not a refund.
    expect(new Decimal(unattributed.value!).toFixed(2)).toBe('1200.00');
    expect(unattributed.descriptor).toBeNull();
  });
});

describe('CASE C — the HIGH-3 shape: a party with only uncategorised and transfer rows', () => {
  it('has no spend and no revenue to show, rather than a figure over an empty drill-down', () => {
    // Old implementation: Supplier Three = 4,100 + 2,020 + 2,020 = 8,140.00 over 0 evidence rows.
    expect(snapshot(org, 'supplier_spend', party.get('Supplier Three')!)).toBeNull();
    expect(snapshot(org, 'customer_revenue', party.get('Customer Three')!)).toBeNull();
  });
});

describe('CASE D — every counterparty snapshot on the organisation reconciles', () => {
  it('each attributed customer_revenue and supplier_spend figure equals its evidence', async () => {
    const ids = adminSql(`select c.metric_key || '|' || c.dimension_id from public.metric_current c
       where c.organization_id = '${org}' and c.metric_key in ('customer_revenue','supplier_spend') and c.dimension_id is not null`)
      .split('\n').map((l) => l.trim()).filter(Boolean);
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
    const supplierUnattributed = snapshot(org, 'supplier_spend', null)!;
    expect(new Decimal(supplierUnattributed.value!).toFixed(2)).toBe('700.00');
    expect(supplierUnattributed.descriptor).toBeNull();
  });
});

describe('CASE E — no eligible commercial rows', () => {
  it('writes no attributed figure, fabricates no evidence, and keeps the covered zero as zero', () => {
    const attributed = adminSql(`select count(*) from public.metric_current c where c.organization_id = '${emptyOrg}'
       and c.metric_key in ('customer_revenue','supplier_spend') and c.dimension_id is not null`).trim();
    expect(attributed).toBe('0');
    // The bank covers the period, so revenue is a known zero, not missing (ADR-104) …
    const revenue = snapshot(emptyOrg, 'revenue', null)!;
    expect(new Decimal(revenue.value!).toFixed(2)).toBe('0.00');
    // … and the Unattributed rows are that zero with no descriptor: nothing to drill into, nothing invented.
    for (const key of ['customer_revenue', 'supplier_spend']) {
      const row = snapshot(emptyOrg, key, null)!;
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
      const snap = snapshot(org, key, party.get(name)!)!;
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
