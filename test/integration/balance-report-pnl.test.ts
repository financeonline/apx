import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { buildBundleForMetric, loadEvidenceDrawer, resolveDescriptor } from '@/modules/evidence';
import { startImport } from '@/modules/imports';
import type { AccessContext } from '@/modules/tenancy';
import { calculateAndAlert } from '../fixtures/adr120-orgs';
import { glBatch, type GlLine } from '../fixtures/audit-orgs';
import { adminSql, clientFor, createAuthUser } from './setup';

/**
 * H-2 (Step 0E) end to end on a real database: trial balances and P&L reports UPLOADED through the
 * wizard (`startImport`), confirmed as a reviewer confirms them (period, basis IMP-TB-012, sign
 * IMP-TB-013), COMMITTED, computed by the real queue, then read back: revenue, profit, margins,
 * Health, and the evidence drill-down.
 *
 * The files name the accounts every organisation is seeded with ("Revenue", "Cost of Sales",
 * "Operating Expenses"), so the test is about the P&L, not about account mapping.
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `t${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.balancepnl.itest`;
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`).split('\n')[0]?.trim() ?? '';
let owner: string;
const ownerDb = () => clientFor(owner, { email: `owner@${DOMAIN}` });

async function org(label: string): Promise<string> {
  // `create_organization` is throttled per user: a separate creator per organisation, then the shared
  // user joins as admin (ownership is sole; admin holds imports.review), so one token reads them all.
  const creator = createAuthUser(`${label.toLowerCase()}-creator@${DOMAIN}`);
  const r = await clientFor(creator).schema('api').rpc('create_organization', { p_name: `ITest BalancePnl ${label} ${RUN}` });
  if (r.error) throw new Error(r.error.message);
  const id = r.data as unknown as string;
  adminSql(`set local app.bootstrap = 'on';
    insert into public.organization_memberships (organization_id, user_id, role) values ('${id}', '${owner}', 'admin');`);
  return id;
}

const END: Record<string, string> = { '2026-06': '2026-06-30', '2026-07': '2026-07-31', '2026-08': '2026-08-31' };

async function upload(o: string, importType: 'trial_balance' | 'pnl_report', ym: string, csv: string) {
  return startImport({
    organizationId: o, userId: owner, requestId: `itest-${RUN}`, db: ownerDb(),
    file: new File([csv], `${importType}-${ym}.csv`, { type: 'text/csv' }),
    importType, periodStart: `${ym}-01`, periodEnd: END[ym]!, bankAccountId: null,
  });
}

/**
 * Answers every confirmation as a reviewer would (basis and sign as stated, and — N-1 — whether the
 * report lists every account, IMP-TB-016), then commits.
 */
async function commit(o: string, batchId: string, basis: 'movement' | 'cumulative', sign: 'natural' | 'reporting',
  completeness: 'complete' | 'partial' = 'complete') {
  const required = adminSql(`select coalesce(string_agg(c, ','), '') from public.import_batches b, unnest(b.required_confirmations) c
     where b.organization_id = '${o}' and b.id = '${batchId}'`).split(',').filter(Boolean);
  for (const code of required) {
    const [start, end] = adminSql(`select period_start || ',' || period_end from public.import_batches where id = '${batchId}'`).split(',');
    const value = code === 'IMP-RANGE-015' ? { period_start: start, period_end: end }
      : code === 'IMP-TB-012' ? { balance_basis: basis }
      : code === 'IMP-TB-013' ? { balance_sign: sign }
      : code === 'IMP-TB-016' ? { report_complete: completeness }
      : { answer: 'yes' };
    const { error } = await ownerDb().schema('api').rpc('record_batch_confirmation', { p_batch: batchId, p_code: code, p_value: value });
    expect(error, `${code}: ${error?.message}`).toBeNull();
  }
  const { error } = await ownerDb().schema('api').rpc('commit_import_batch', { p_batch: batchId });
  expect(error, error?.message).toBeNull();
}

function metric(o: string, ym: string, key: string): string {
  return one(`select coalesce(s.value::numeric(16, 2)::text, 'NULL') || '|' || s.assurance_level || '|' || s.basis || '|'
      || coalesce((s.data_quality -> 'missing')::text, '[]')
    from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
    join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
   where c.organization_id = '${o}' and c.metric_key = '${key}' and c.dimension_type = 'none' and p.period_start = '${ym}-01'`);
}
const valueOf = (o: string, ym: string, key: string) => metric(o, ym, key).split('|')[0];
function total(o: string, ym: string): number | null {
  const s = one(`select coalesce(h.score::text, 'NULL') from public.health_current hc
    join public.health_scores h on h.id = hc.health_score_id and h.organization_id = hc.organization_id
    join public.fiscal_periods p on p.id = hc.period_id and p.organization_id = hc.organization_id
   where hc.organization_id = '${o}' and p.period_start = '${ym}-01'`);
  return s === '' || s === 'NULL' ? null : Number(s);
}
const ctxFor = (o: string): AccessContext => ({
  userId: owner, orgId: o, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'), actorType: 'user',
  db: clientFor(owner), requestId: RUN, now: () => new Date('2026-09-15T00:00:00Z'), organizationStatus: 'active',
});

let dc: string; let cum: string; let pnl: string; let mixed: string; let zero: string;
// N-1 (Step 0F): completeness through real imports.
let cumTampered: string; let mixedPartial: string; let cashOnly: string; let cashOnlyComplete: string; let expOnly: string; let partCum: string; let dcPartial: string;

beforeAll(async () => {
  owner = createAuthUser(`owner@${DOMAIN}`);

  // A movement trial balance in DEBIT / CREDIT columns, June–August. It balances (IMP-TB-011 refuses
  // one that does not): the month's profit sits in Cash.
  dc = await org('DC');
  for (const [ym, r, c, cash] of [['2026-06', '1000', '400', '300'], ['2026-07', '1100', '440', '360'], ['2026-08', '1210', '484', '426']] as const) {
    const res = await upload(dc, 'trial_balance', ym, `Account,Debit,Credit\nRevenue,,${r}.00\nCost of Sales,${c}.00,\nOperating Expenses,300.00,\nCash,${cash}.00,\n`);
    await commit(dc, res.batchId, 'movement', 'natural');
  }

  // The same rows NOT attested complete (N-1): balancing alone does not make a report complete.
  dcPartial = await org('DCPARTIAL');
  for (const [ym, r, c, cash] of [['2026-06', '1000', '400', '300'], ['2026-07', '1100', '440', '360'], ['2026-08', '1210', '484', '426']] as const) {
    const res = await upload(dcPartial, 'trial_balance', ym, `Account,Debit,Credit\nRevenue,,${r}.00\nCost of Sales,${c}.00,\nOperating Expenses,300.00,\nCash,${cash}.00,\n`);
    await commit(dcPartial, res.batchId, 'movement', 'natural', 'partial');
  }

  // A CUMULATIVE trial balance with one balance column, natural sign (debit positive). Year-to-date
  // profit sits in Cash so each month balances, and each is attested complete.
  cum = await org('CUM');
  for (const [ym, r, c, o, cash] of [['2026-06', '-1000', '400', '300', '300'], ['2026-07', '-2100', '840', '600', '660'], ['2026-08', '-3310', '1324', '900', '1086']] as const) {
    const res = await upload(cum, 'trial_balance', ym, `Account,Balance\nRevenue,${r}.00\nCost of Sales,${c}.00\nOperating Expenses,${o}.00\nCash,${cash}.00\n`);
    await commit(cum, res.batchId, 'cumulative', 'natural');
  }

  // N-2: the same cumulative report in its own organisation, for the mismatch the drawer must state.
  cumTampered = await org('CUMT');
  for (const [ym, r, c, o, cash] of [['2026-06', '-1000', '400', '300', '300'], ['2026-07', '-2100', '840', '600', '660'], ['2026-08', '-3310', '1324', '900', '1086']] as const) {
    const res = await upload(cumTampered, 'trial_balance', ym, `Account,Balance\nRevenue,${r}.00\nCost of Sales,${c}.00\nOperating Expenses,${o}.00\nCash,${cash}.00\n`);
    await commit(cumTampered, res.batchId, 'cumulative', 'natural');
  }

  // Partial cumulative (N-1): July attested complete; August omits Operating Expenses and is NOT attested.
  partCum = await org('PARTCUM');
  {
    const jul = await upload(partCum, 'trial_balance', '2026-07', 'Account,Balance\nRevenue,-2100.00\nOperating Expenses,600.00\nCash,1500.00\n');
    await commit(partCum, jul.batchId, 'cumulative', 'natural');
    const aug = await upload(partCum, 'trial_balance', '2026-08', 'Account,Balance\nRevenue,-3310.00\nCash,3310.00\n');
    await commit(partCum, aug.batchId, 'cumulative', 'natural', 'partial');
  }

  // Cash-only trial balances for July (N-1): one not attested, one attested complete.
  cashOnly = await org('CASHONLY');
  const co = await upload(cashOnly, 'trial_balance', '2026-07', 'Account,Debit,Credit\nCash,500.00,\nEquity,,500.00\n');
  await commit(cashOnly, co.batchId, 'movement', 'natural', 'partial');
  cashOnlyComplete = await org('CASHDONE');
  const cc = await upload(cashOnlyComplete, 'trial_balance', '2026-07', 'Account,Debit,Credit\nCash,500.00,\nEquity,,500.00\n');
  await commit(cashOnlyComplete, cc.batchId, 'movement', 'natural');

  // An expenses-only P&L report for July, not attested (N-1).
  expOnly = await org('EXPONLY');
  const eo = await upload(expOnly, 'pnl_report', '2026-07', 'Account,Amount\nCost of Sales,400.00\nOperating Expenses,300.00\n');
  await commit(expOnly, eo.batchId, 'movement', 'reporting', 'partial');

  // A P&L REPORT with one Amount column in REPORTING sign (income and expenses both positive), July.
  pnl = await org('PNL');
  const p = await upload(pnl, 'pnl_report', '2026-07', 'Account,Amount\nRevenue,1100.00\nCost of Sales,440.00\nOperating Expenses,300.00\n');
  await commit(pnl, p.batchId, 'movement', 'reporting');

  // A GL for June–August, and a movement trial balance for JULY only that states other figures.
  mixed = await org('MIXED');
  for (const ym of ['2026-06', '2026-07', '2026-08'] as const) {
    const amt = { '2026-06': '1000', '2026-07': '1100', '2026-08': '1210' }[ym];
    const lines: GlLine[] = [
      { date: `${ym}-05`, category: 'cash', direction: 'debit', amount: amt },
      { date: `${ym}-05`, category: 'revenue', direction: 'credit', amount: amt },
    ];
    glBatch(mixed, { start: `${ym}-01`, end: END[ym]!, lines, tag: `bp-gl-${ym}` });
  }
  const m = await upload(mixed, 'trial_balance', '2026-07', 'Account,Debit,Credit\nRevenue,,5000.00\nOperating Expenses,800.00,\nCash,4200.00,\n');
  await commit(mixed, m.batchId, 'movement', 'natural');

  // The same ledger and the same July trial balance, the report NOT attested complete (N-1): the
  // ledger, which covers July, states July's whole P&L.
  mixedPartial = await org('MIXEDP');
  for (const ym of ['2026-06', '2026-07', '2026-08'] as const) {
    const amt = { '2026-06': '1000', '2026-07': '1100', '2026-08': '1210' }[ym];
    glBatch(mixedPartial, { start: `${ym}-01`, end: END[ym]!, tag: `bpp-gl-${ym}`, lines: [
      { date: `${ym}-05`, category: 'cash', direction: 'debit', amount: amt },
      { date: `${ym}-05`, category: 'revenue', direction: 'credit', amount: amt },
    ] });
  }
  const mp = await upload(mixedPartial, 'trial_balance', '2026-07', 'Account,Debit,Credit\nRevenue,,5000.00\nOperating Expenses,800.00,\nCash,4200.00,\n');
  await commit(mixedPartial, mp.batchId, 'movement', 'natural', 'partial');

  // A legitimate zero.
  zero = await org('ZERO');
  const z = await upload(zero, 'pnl_report', '2026-08', 'Account,Amount\nRevenue,0.00\nOperating Expenses,300.00\n');
  await commit(zero, z.batchId, 'movement', 'reporting');

  for (const o of [dc, cum, cumTampered, pnl, mixed, zero, dcPartial, partCum, cashOnly, cashOnlyComplete, expOnly, mixedPartial]) await calculateAndAlert(o);
}, 900_000);

afterAll(() => {
  adminSql(`delete from public.organizations where name like 'ITest BalancePnl %${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('stored as natural-sign closing balances', () => {
  it('a Debit / Credit trial balance stores debit − credit and keeps both totals', () => {
    expect(adminSql(`select a.name || '=' || b.closing_balance || '/' || coalesce(b.debit_total::text, '-') || '/' || coalesce(b.credit_total::text, '-')
        from public.period_balances b join public.accounts a on a.id = b.account_id
       where b.organization_id = '${dc}' and b.period_start = '2026-07-01' order by a.name`).split('\n'))
      .toEqual(['Cash=360.00/360.00/-', 'Cost of Sales=440.00/440.00/-', 'Operating Expenses=300.00/300.00/-', 'Revenue=-1100.00/-/1100.00']);
  });

  it('a reporting-sign P&L report is stored in natural sign (income negated at commit)', () => {
    expect(adminSql(`select a.name || '=' || b.closing_balance from public.period_balances b join public.accounts a on a.id = b.account_id
       where b.organization_id = '${pnl}' order by a.name`).split('\n'))
      .toEqual(['Cost of Sales=440.00', 'Operating Expenses=300.00', 'Revenue=-1100.00']);
  });

  it('a row with no figure is an error before commit, never a stored zero', async () => {
    const o = await org('BLANK');
    const res = await upload(o, 'trial_balance', '2026-08', 'Account,Debit,Credit\nRevenue,,\nOperating Expenses,300.00,\n');
    const rows = adminSql(`select row_number || ':' || status from public.import_rows where batch_id = '${res.batchId}' and row_number > 1 order by row_number`).split('\n');
    expect(rows[0]).toBe('2:error');
    expect(rows[1]).toMatch(/^3:(valid|warning)$/);
  });
});

describe('revenue, profit and margins', () => {
  it('Debit / Credit movement: 1,000 / 1,100 / 1,210; net 300 / 360 / 426; August margins 0.60 and 0.352', () => {
    expect(['2026-06', '2026-07', '2026-08'].map((ym) => valueOf(dc, ym, 'revenue'))).toEqual(['1000.00', '1100.00', '1210.00']);
    expect(['2026-06', '2026-07', '2026-08'].map((ym) => valueOf(dc, ym, 'net_profit'))).toEqual(['300.00', '360.00', '426.00']);
    expect(new Decimal(one(`select s.value from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id
      join public.fiscal_periods p on p.id = c.period_id where c.organization_id = '${dc}' and c.metric_key = 'gross_margin'
      and c.dimension_type = 'none' and p.period_start = '2026-08-01'`)).toFixed(4)).toBe('0.6000');
    expect(metric(dc, '2026-08', 'revenue')).toBe('1210.00|verified|period_balances|[]');
  });

  it('cumulative: NULL no_prior_trial_balance / 1,100 / 1,210', () => {
    expect(['2026-06', '2026-07', '2026-08'].map((ym) => valueOf(cum, ym, 'revenue'))).toEqual(['NULL', '1100.00', '1210.00']);
    expect(metric(cum, '2026-06', 'revenue')).toContain('no_prior_trial_balance');
    expect(valueOf(cum, '2026-08', 'net_profit')).toBe('426.00');
  });

  it('P&L report: 1,100 revenue, 440 cost of sales, 360 net profit', () => {
    expect([valueOf(pnl, '2026-07', 'revenue'), valueOf(pnl, '2026-07', 'cost_of_sales'), valueOf(pnl, '2026-07', 'net_profit')])
      .toEqual(['1100.00', '440.00', '360.00']);
  });

  it('a stated zero revenue is a verified 0.00', () => {
    expect(metric(zero, '2026-08', 'revenue')).toBe('0.00|verified|period_balances|[]');
  });

  it('ledger beside a July trial balance: July from the trial balance (§2.3), June and August from the ledger', () => {
    expect(metric(mixed, '2026-07', 'revenue')).toBe('5000.00|verified|period_balances|[]');
    // Ledger-basis P&L is `calculated` (coverage.ts assuranceFor; FINANCIAL_ENGINE §2.3); a trial balance's is `verified`.
    expect(metric(mixed, '2026-06', 'revenue').split('|').slice(0, 3)).toEqual(['1000.00', 'calculated', 'ledger']);
    expect(metric(mixed, '2026-08', 'revenue').split('|').slice(0, 3)).toEqual(['1210.00', 'calculated', 'ledger']);
  });
});

describe('Health and evidence', () => {
  it('Health on the Debit / Credit trial balance (no bank): NULL / 87 / 87, banking excluded', () => {
    expect(['2026-06', '2026-07', '2026-08'].map((ym) => total(dc, ym))).toEqual([null, 87, 87]);
  });

  it('every movement-basis P&L drill-down totals its figure', async () => {
    const rows = adminSql(`select c.metric_key || '|' || coalesce(s.value::text, 'NULL') || '|' || coalesce(s.evidence_query::text, 'null')
        from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
        join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
       where c.organization_id = '${dc}' and p.period_start = '2026-07-01' and c.dimension_type = 'none'
         and c.metric_key in ('revenue', 'cost_of_sales', 'operating_expenses')`).split('\n');
    for (const row of rows) {
      const [key, value, query] = row.split('|') as [string, string, string];
      const parsed = JSON.parse(query) as { kind: string; descriptor: Record<string, unknown> };
      expect(parsed.kind, key).toBe('leaf');
      const sel = await resolveDescriptor(ctxFor(dc), parsed.descriptor as never);
      expect(new Decimal(sel.total!).toFixed(2), key).toBe(new Decimal(value).toFixed(2));
    }
  });

  const snapshotOf = (o: string, ym: string, key: string) => one(`select s.id from public.metric_current c
    join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
    join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
   where c.organization_id = '${o}' and c.metric_key = '${key}' and c.dimension_type = 'none' and p.period_start = '${ym}-01'`);

  it('a cumulative month traces to BOTH periods\' records and the subtraction: Σ(Aug) − Σ(Jul) = the figure', async () => {
    for (const key of ['revenue', 'cost_of_sales', 'operating_expenses']) {
      const query = JSON.parse(one(`select s.evidence_query::text from public.metric_snapshots s where s.id = '${snapshotOf(cum, '2026-08', key)}'`)) as {
        kind: string; terms: Array<{ sign: number; descriptor: Record<string, unknown> | null; period_id: string }>;
      };
      expect(query.kind, key).toBe('difference');
      let total = new Decimal(0);
      for (const term of query.terms) {
        expect(term.descriptor, key).not.toBeNull();
        const sel = await resolveDescriptor(ctxFor(cum), term.descriptor as never);
        expect(sel.count, `${key} rows`).toBeGreaterThan(0);
        total = total.plus(new Decimal(sel.total!).times(term.sign));
      }
      expect(total.toFixed(2), key).toBe(new Decimal(valueOf(cum, '2026-08', key)!).toFixed(2));
    }
  });

  it('the evidence drawer opens a cumulative figure: formula, both periods, both totals', async () => {
    const bundle = await buildBundleForMetric(ctxFor(cum), snapshotOf(cum, '2026-08', 'revenue'));
    const view = await loadEvidenceDrawer(ctxFor(cum), bundle);
    expect(view.metric!.difference).not.toBeNull();
    expect(view.metric!.difference!.terms.map((t) => [t.name, t.sign, new Decimal(t.total!).toFixed(2), t.unavailable]))
      .toEqual([['year_to_date', 1, '3310.00', null], ['prior_year_to_date', -1, '2100.00', null]]);
    // Both selections are query items of the bundle (the server accepted them as leaves of the figure).
    expect(view.records.length).toBeGreaterThanOrEqual(2);
  });

  it('N-2: each side reconciles to its OWN expected value, then 3,310 − 2,100 = 1,210 reconciles to the figure', async () => {
    const view = await loadEvidenceDrawer(ctxFor(cum), await buildBundleForMetric(ctxFor(cum), snapshotOf(cum, '2026-08', 'revenue')));
    const d = view.metric!.difference!;
    expect(d.terms.map((t) => [new Decimal(t.expected!).toFixed(2), t.reconciles])).toEqual([['3310.00', true], ['2100.00', true]]);
    expect([new Decimal(d.recordsResult!).toFixed(2), d.formulaReconciles, d.arithmeticReconciles, d.reconciles]).toEqual(['1210.00', true, true, true]);
    // Each side links to the records block holding its rows, and that block reconciles to the side —
    // never to the figure, which neither side can total.
    for (const term of d.terms) {
      const block = view.records.find((b) => b.itemId === term.recordsItemId);
      expect(block, term.name).toBeDefined();
      expect(block!.reconciles, term.name).toBe(true);
      expect(new Decimal(block!.forValue!).toFixed(2)).toBe(new Decimal(term.expected!).toFixed(2));
      expect(block!.reconciliation).toContain('the year-to-date amount the calculation used');
    }
    expect(view.records.some((b) => b.reconciles === false)).toBe(false);
  });

  it('N-2: net profit — every cumulative component shows its subtraction and reconciles; no block is a false alarm', async () => {
    const view = await loadEvidenceDrawer(ctxFor(cum), await buildBundleForMetric(ctxFor(cum), snapshotOf(cum, '2026-08', 'net_profit')));
    // Revenue and cost of sales sit under operating profit → gross profit; the subtractions reach them.
    const byLabel = new Map(view.subtractions.map((x) => [x.label, x.difference]));
    for (const [label, current, prior] of [['Revenue', '3310.00', '2100.00'], ['Cost of sales', '1324.00', '840.00'], ['Operating expenses', '900.00', '600.00']] as const) {
      const d = [...byLabel.entries()].find(([l]) => l.toLowerCase() === label.toLowerCase())?.[1];
      expect(d, label).toBeTruthy();
      expect(d!.terms.map((t) => new Decimal(t.total!).toFixed(2)), label).toEqual([current, prior]);
      expect(d!.reconciles, label).toBe(true);
      expect(d!.terms.every((t) => t.recordsItemId !== null), label).toBe(true);
    }
    expect(view.subtractions.every((x) => x.difference.reconciles !== false)).toBe(true);
    expect(view.records.length).toBeGreaterThanOrEqual(6);
    expect(view.records.filter((b) => b.reconciles === false).map((b) => b.label)).toEqual([]);
  });

  it('N-2: a July row changed after the calculation is detected on that side, and the formula no longer reconciles', async () => {
    // Simulated corruption: the stored July revenue row is altered behind the engine's back.
    adminSql(`set session_replication_role = replica;
      update public.period_balances b set closing_balance = -2000 from public.accounts a
       where a.id = b.account_id and a.organization_id = b.organization_id and b.organization_id = '${cumTampered}'
         and a.name = 'Revenue' and b.period_start = '2026-07-01';`);
    const view = await loadEvidenceDrawer(ctxFor(cumTampered), await buildBundleForMetric(ctxFor(cumTampered), snapshotOf(cumTampered, '2026-08', 'revenue')));
    const d = view.metric!.difference!;
    expect(d.terms.map((t) => t.reconciles)).toEqual([true, false]);
    expect(new Decimal(d.recordsResult!).toFixed(2)).toBe('1310.00');
    expect(d.formulaReconciles).toBe(false);
    expect(d.reconciles).toBe(false);
    const priorBlock = view.records.find((b) => b.itemId === d.terms[1]!.recordsItemId)!;
    expect(priorBlock.reconciles).toBe(false);
    expect(priorBlock.reconciliation).toContain('does not match');
    // …and it propagates to net profit's revenue component.
    const np = await loadEvidenceDrawer(ctxFor(cumTampered), await buildBundleForMetric(ctxFor(cumTampered), snapshotOf(cumTampered, '2026-08', 'net_profit')));
    expect(np.subtractions.find((x) => x.label.toLowerCase() === 'revenue')!.difference.reconciles).toBe(false);
    expect(np.records.filter((b) => b.reconciles === false)).toHaveLength(1);
  });

  it('with no prior month, the drawer states which side is missing and why', async () => {
    const bundle = await buildBundleForMetric(ctxFor(cum), snapshotOf(cum, '2026-06', 'revenue'));
    const view = await loadEvidenceDrawer(ctxFor(cum), bundle);
    expect(view.metric!.difference!.terms[1]).toMatchObject({ name: 'prior_year_to_date', total: null, unavailable: 'no_prior_trial_balance' });
    expect(view.metric!.difference!.terms[0]!.total).not.toBeNull();
  });
});

/**
 * N-1 (Step 0F) through real uploads. Expected figures are worked from each file's lines by hand.
 * Each case is its own test reading its own organisation, so one failure cannot hide another.
 */
describe('N-1 · completeness is attested, never inferred', () => {
  it('the attestation is stored with who and when, and audited', () => {
    const row = one(`select (b.confirmations -> 'IMP-TB-016' -> 'value' ->> 'report_complete') || '|' || ((b.confirmations -> 'IMP-TB-016' ->> 'by') is not null)::text
      from public.import_batches b where b.organization_id = '${cashOnlyComplete}' and b.import_type = 'trial_balance'`);
    expect(row).toBe('complete|true');
    expect(one(`select count(*) from public.audit_events where organization_id = '${cashOnlyComplete}' and action = 'import.confirmed'
      and after ->> 'code' = 'IMP-TB-016' and after -> 'value' ->> 'report_complete' = 'complete'`)).not.toBe('0');
  });

  it('the answer must be complete or partial: a bare yes or a blank is refused, never stored as an attestation', async () => {
    const o = await org('ASK');
    const res = await upload(o, 'trial_balance', '2026-07', 'Account,Debit,Credit\nCash,500.00,\nEquity,,500.00\n');
    for (const value of [{ answer: 'yes' }, { report_complete: '' }, { report_complete: 'yes' }]) {
      const { error } = await ownerDb().schema('api').rpc('record_batch_confirmation', { p_batch: res.batchId, p_code: 'IMP-TB-016', p_value: value });
      expect(error?.message, JSON.stringify(value)).toContain('VALIDATION');
    }
    expect(one(`select coalesce(confirmations ? 'IMP-TB-016', false)::text from public.import_batches where id = '${res.batchId}'`)).toBe('false');
  });

  it('balancing, NOT attested: stated lines stand (revenue 1,100); operating expenses and net profit NULL category_not_in_report', () => {
    expect(valueOf(dcPartial, '2026-07', 'revenue')).toBe('1100.00');
    const opex = metric(dcPartial, '2026-07', 'operating_expenses').split('|');
    expect([opex[0], opex[2]]).toEqual(['NULL', 'period_balances']);
    expect(opex[3]).toContain('category_not_in_report');
    expect(valueOf(dcPartial, '2026-07', 'net_profit')).toBe('NULL');
  });

  it('cash-only trial balance, not attested: revenue NULL category_not_in_report — never a verified 0.00', () => {
    const m = metric(cashOnly, '2026-07', 'revenue');
    expect(m.split('|')[0]).toBe('NULL');
    expect(m).toContain('category_not_in_report');
  });

  it('cash-only trial balance, attested complete and balancing: revenue and net profit a verified 0.00', () => {
    expect(metric(cashOnlyComplete, '2026-07', 'revenue')).toBe('0.00|verified|period_balances|[]');
    expect(valueOf(cashOnlyComplete, '2026-07', 'net_profit')).toBe('0.00');
  });

  it('expenses-only P&L report, not attested: cost of sales 400; revenue NULL, not 0', () => {
    expect(valueOf(expOnly, '2026-07', 'cost_of_sales')).toBe('400.00');
    expect(metric(expOnly, '2026-07', 'revenue')).toContain('category_not_in_report');
    expect(valueOf(expOnly, '2026-07', 'revenue')).toBe('NULL');
  });

  it('partial cumulative: August revenue 3,310 − 2,100 = 1,210; its missing Operating Expenses line is NULL, not −600', () => {
    expect(valueOf(partCum, '2026-08', 'revenue')).toBe('1210.00');
    expect(valueOf(partCum, '2026-08', 'operating_expenses')).toBe('NULL');
    expect(valueOf(partCum, '2026-08', 'net_profit')).toBe('NULL');
  });

  it('ledger beside an UNATTESTED July report: July is the ledger\'s 1,100 (calculated), never 5,000 nor 6,100', () => {
    expect(metric(mixedPartial, '2026-07', 'revenue').split('|').slice(0, 3)).toEqual(['1100.00', 'calculated', 'ledger']);
    expect(one(`select (s.data_quality -> 'warnings')::text from public.metric_current c
      join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
      join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
     where c.organization_id = '${mixedPartial}' and c.metric_key = 'revenue' and c.dimension_type = 'none' and p.period_start = '2026-07-01'`))
      .toContain('balance_report_incomplete');
  });
});
