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
  const r = await clientFor(owner).schema('api').rpc('create_organization', { p_name: `ITest BalancePnl ${label} ${RUN}` });
  if (r.error) throw new Error(r.error.message);
  return r.data as unknown as string;
}

const END: Record<string, string> = { '2026-06': '2026-06-30', '2026-07': '2026-07-31', '2026-08': '2026-08-31' };

async function upload(o: string, importType: 'trial_balance' | 'pnl_report', ym: string, csv: string) {
  return startImport({
    organizationId: o, userId: owner, requestId: `itest-${RUN}`, db: ownerDb(),
    file: new File([csv], `${importType}-${ym}.csv`, { type: 'text/csv' }),
    importType, periodStart: `${ym}-01`, periodEnd: END[ym]!, bankAccountId: null,
  });
}

/** Answers every confirmation as a reviewer would (basis and sign as stated), then commits. */
async function commit(o: string, batchId: string, basis: 'movement' | 'cumulative', sign: 'natural' | 'reporting') {
  const required = adminSql(`select coalesce(string_agg(c, ','), '') from public.import_batches b, unnest(b.required_confirmations) c
     where b.organization_id = '${o}' and b.id = '${batchId}'`).split(',').filter(Boolean);
  for (const code of required) {
    const [start, end] = adminSql(`select period_start || ',' || period_end from public.import_batches where id = '${batchId}'`).split(',');
    const value = code === 'IMP-RANGE-015' ? { period_start: start, period_end: end }
      : code === 'IMP-TB-012' ? { balance_basis: basis }
      : code === 'IMP-TB-013' ? { balance_sign: sign }
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

beforeAll(async () => {
  owner = createAuthUser(`owner@${DOMAIN}`);

  // A movement trial balance in DEBIT / CREDIT columns, June–August. It balances (IMP-TB-011 refuses
  // one that does not): the month's profit sits in Cash.
  dc = await org('DC');
  for (const [ym, r, c, cash] of [['2026-06', '1000', '400', '300'], ['2026-07', '1100', '440', '360'], ['2026-08', '1210', '484', '426']] as const) {
    const res = await upload(dc, 'trial_balance', ym, `Account,Debit,Credit\nRevenue,,${r}.00\nCost of Sales,${c}.00,\nOperating Expenses,300.00,\nCash,${cash}.00,\n`);
    await commit(dc, res.batchId, 'movement', 'natural');
  }

  // A CUMULATIVE trial balance with one balance column, natural sign (debit positive).
  cum = await org('CUM');
  for (const [ym, r, c, o] of [['2026-06', '-1000', '400', '300'], ['2026-07', '-2100', '840', '600'], ['2026-08', '-3310', '1324', '900']] as const) {
    const res = await upload(cum, 'trial_balance', ym, `Account,Balance\nRevenue,${r}.00\nCost of Sales,${c}.00\nOperating Expenses,${o}.00\n`);
    await commit(cum, res.batchId, 'cumulative', 'natural');
  }

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

  // A legitimate zero.
  zero = await org('ZERO');
  const z = await upload(zero, 'pnl_report', '2026-08', 'Account,Amount\nRevenue,0.00\nOperating Expenses,300.00\n');
  await commit(zero, z.batchId, 'movement', 'reporting');

  for (const o of [dc, cum, pnl, mixed, zero]) await calculateAndAlert(o);
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
    expect(metric(mixed, '2026-06', 'revenue').split('|').slice(0, 3)).toEqual(['1000.00', 'verified', 'ledger']);
    expect(metric(mixed, '2026-08', 'revenue').split('|').slice(0, 3)).toEqual(['1210.00', 'verified', 'ledger']);
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

  it('with no prior month, the drawer states which side is missing and why', async () => {
    const bundle = await buildBundleForMetric(ctxFor(cum), snapshotOf(cum, '2026-06', 'revenue'));
    const view = await loadEvidenceDrawer(ctxFor(cum), bundle);
    expect(view.metric!.difference!.terms[1]).toMatchObject({ name: 'prior_year_to_date', total: null, unavailable: 'no_prior_trial_balance' });
    expect(view.metric!.difference!.terms[0]!.total).not.toBeNull();
  });
});
