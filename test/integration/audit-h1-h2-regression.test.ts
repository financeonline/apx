import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calculateAndAlert } from '../fixtures/adr120-orgs';
import { balanceBatch, glBatch, type GlLine } from '../fixtures/audit-orgs';
import { bankAccount, statement } from '../fixtures/step0d-orgs';
import { adminSql, clientFor, createAuthUser } from './setup';

/**
 * Regression for H-1 and H-2 of the independent audit of step0d-review-frozen (c5a8473), on a real
 * database through the real queue. The organisations are the auditor's own fixtures
 * (`fix/step0-audit-independent`, test/audit/audit-step0d.test.ts): the same rows, the same months.
 *
 * What the frozen commit stored (the audit's runs 37293475857 / 37294715620), and what is right:
 *   HT-NOBANK totals          78 / 83 / 83 (banking 60, B4 "full")  →  NULL / 87 / 87, banking excluded
 *   TBMOV, TBDC revenue        0.00 / 0.00 / 0.00 verified            →  1,000 / 1,100 / 1,210
 *   TBCUM revenue              0.00 / 0.00 / 0.00 verified            →  NULL no_prior_trial_balance / 1,100 / 1,210
 *   HT-CSV totals (control)    77 / 81 / 92                           →  unchanged
 *
 * Every expected figure is the auditor's hand computation from FINANCIAL_ENGINE §3 / §7 and
 * `health/domain/config.ts` (AUDIT_REPORT.md §2), restated here — not read back from the engine.
 * Run-unique fixtures (ADR-052.12).
 *
 * Step 0F (N-1): the auditor's trial balances are three-line extracts — revenue, cost of sales,
 * operating expense — that neither balance nor carry the reviewer's attestation (IMP-TB-016) that they
 * list every account. Their stated lines still state revenue and cost of sales; the categories they
 * have no line for (payroll, marketing, …) are NULL `category_not_in_report`, so operating expenses and
 * net profit are NULL, and Health has only revenue growth (§7: fewer than 3 dimensions → no score).
 * The figures the audit expected for a COMPLETE report are asserted on attested, balancing copies
 * (TBMOV-C, TBCUM-C): the same lines plus an Equity line, attested complete.
 */

const RUN = `t${Date.now().toString(36)}`;
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`).split('\n')[0]?.trim() ?? '';
const owners: string[] = [];

async function org(label: string): Promise<string> {
  const owner = createAuthUser(`${label.toLowerCase()}@${RUN}.auditreg.itest`);
  owners.push(owner);
  const r = await clientFor(owner).schema('api').rpc('create_organization', { p_name: `ITest AuditReg ${label} ${RUN}` });
  if (r.error) throw new Error(r.error.message);
  return r.data as unknown as string;
}

const MONTHS = ['2026-06', '2026-07', '2026-08'] as const;
const END: Record<string, string> = { '2026-06': '2026-06-30', '2026-07': '2026-07-31', '2026-08': '2026-08-31' };
const R: Record<string, string> = { '2026-06': '1000', '2026-07': '1100', '2026-08': '1210' };
const C: Record<string, string> = { '2026-06': '400', '2026-07': '440', '2026-08': '484' };
const O: Record<string, string> = { '2026-06': '300', '2026-07': '300', '2026-08': '300' };

function htLedger(o: string): void {
  for (const ym of MONTHS) {
    const lines: GlLine[] = [
      { date: `${ym}-05`, category: 'cash', direction: 'debit', amount: R[ym]! },
      { date: `${ym}-05`, category: 'revenue', direction: 'credit', amount: R[ym]! },
      { date: `${ym}-12`, category: 'cost_of_sales', direction: 'debit', amount: C[ym]! },
      { date: `${ym}-12`, category: 'cash', direction: 'credit', amount: C[ym]! },
      { date: `${ym}-25`, category: 'operating_expense', direction: 'debit', amount: O[ym]! },
      { date: `${ym}-25`, category: 'cash', direction: 'credit', amount: O[ym]! },
    ];
    glBatch(o, { start: `${ym}-01`, end: END[ym]!, lines, tag: `ar-gl-${ym}` });
  }
}

function htBank(o: string): void {
  const bank = bankAccount(o, 'Main');
  const moves = (ym: string): Array<[string, string]> => [[`${ym}-05`, R[ym]!], [`${ym}-12`, `-${C[ym]!}`], [`${ym}-25`, `-${O[ym]!}`]];
  statement(o, bank, { start: '2026-06-01', end: '2026-06-30', extraction: 'csv', opening: '5000', closing: '5300', moves: moves('2026-06'), tag: 'ar-jun' });
  statement(o, bank, { start: '2026-07-01', end: '2026-07-31', extraction: 'csv', moves: moves('2026-07'), tag: 'ar-jul' });
  statement(o, bank, { start: '2026-08-01', end: '2026-08-31', extraction: 'csv', moves: moves('2026-08'), tag: 'ar-aug' });
}

/** Current total per month, Jun → Aug (NULL where no score or a NULL score). */
function totals(o: string): Array<number | null> {
  return MONTHS.map((ym) => {
    const s = one(`select coalesce(h.score::text, 'NULL') from public.health_current hc
      join public.health_scores h on h.id = hc.health_score_id and h.organization_id = hc.organization_id
      join public.fiscal_periods p on p.id = hc.period_id and p.organization_id = hc.organization_id
     where hc.organization_id = '${o}' and p.period_start = '${ym}-01'`);
    return s === '' || s === 'NULL' ? null : Number(s);
  });
}

/** `included|exclusion_reason|B4 result` of banking_health in a month. */
function banking(o: string, ym: string): string {
  return one(`select (d ->> 'included') || '|' || coalesce(d ->> 'exclusion_reason', '') || '|'
      || coalesce((select r ->> 'result' from jsonb_array_elements(d -> 'rules') r where r ->> 'rule' = 'B4'), '')
    from public.health_current hc join public.health_scores h on h.id = hc.health_score_id and h.organization_id = hc.organization_id
    join public.fiscal_periods p on p.id = hc.period_id and p.organization_id = hc.organization_id,
    jsonb_array_elements(h.breakdown) d
   where hc.organization_id = '${o}' and p.period_start = '${ym}-01' and d ->> 'key' = 'banking_health'`);
}

/** `value|assurance|basis|missing` of the current headline snapshot. */
function metric(o: string, ym: string, key: string): string {
  return one(`select coalesce(s.value::numeric(16, 2)::text, 'NULL') || '|' || s.assurance_level || '|' || s.basis || '|'
      || coalesce((s.data_quality -> 'missing')::text, '[]')
    from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
    join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
   where c.organization_id = '${o}' and c.metric_key = '${key}' and c.dimension_type = 'none' and p.period_start = '${ym}-01'`);
}
const values = (o: string, key: string) => MONTHS.map((ym) => metric(o, ym, key).split('|')[0]);

let csv: string; let nobank: string; let tbmov: string; let tbcum: string; let tbdc: string; let tbmovC: string; let tbcumC: string;

beforeAll(async () => {
  csv = await org('HTCSV'); htLedger(csv); htBank(csv);
  nobank = await org('HTNOBANK'); htLedger(nobank);
  tbmov = await org('TBMOV'); tbcum = await org('TBCUM'); tbdc = await org('TBDC');
  const cum: Record<string, [string, string, string]> = { '2026-06': ['-1000', '400', '300'], '2026-07': ['-2100', '840', '600'], '2026-08': ['-3310', '1324', '900'] };
  for (const ym of MONTHS) {
    balanceBatch(tbmov, { importType: 'trial_balance', basis: 'movement', start: `${ym}-01`, end: END[ym]!, tag: `rm-${ym}`,
      rows: [['revenue', `-${R[ym]!}`], ['cost_of_sales', C[ym]!], ['operating_expense', O[ym]!]] });
    const [r, c, o] = cum[ym]!;
    balanceBatch(tbcum, { importType: 'trial_balance', basis: 'cumulative', start: `${ym}-01`, end: END[ym]!, tag: `rc-${ym}`,
      rows: [['revenue', r], ['cost_of_sales', c], ['operating_expense', o]] });
    balanceBatch(tbdc, { importType: 'trial_balance', basis: 'movement', start: `${ym}-01`, end: END[ym]!, tag: `rd-${ym}`,
      rows: [['revenue', `-${R[ym]!}`], ['cost_of_sales', C[ym]!], ['operating_expense', O[ym]!]] });
  }
  // N-1: the same lines, balanced by an Equity line and attested complete.
  tbmovC = await org('TBMOVC'); tbcumC = await org('TBCUMC');
  for (const ym of MONTHS) {
    const eqMov = `${Number(R[ym]!) - Number(C[ym]!) - Number(O[ym]!)}`;
    balanceBatch(tbmovC, { importType: 'trial_balance', basis: 'movement', start: `${ym}-01`, end: END[ym]!, tag: `rmc-${ym}`, complete: true,
      rows: [['revenue', `-${R[ym]!}`], ['cost_of_sales', C[ym]!], ['operating_expense', O[ym]!], ['equity', eqMov]] });
    const [r, c, o] = cum[ym]!;
    const eqCum = `${-(Number(r) + Number(c) + Number(o))}`;
    balanceBatch(tbcumC, { importType: 'trial_balance', basis: 'cumulative', start: `${ym}-01`, end: END[ym]!, tag: `rcc-${ym}`, complete: true,
      rows: [['revenue', r], ['cost_of_sales', c], ['operating_expense', o], ['equity', eqCum]] });
  }
  // The auditor's control: debit/credit totals filled. They must no longer matter.
  adminSql(`update public.period_balances set debit_total = greatest(closing_balance, 0), credit_total = greatest(-closing_balance, 0)
    where organization_id = '${tbdc}'`);
  for (const o of [csv, nobank, tbmov, tbcum, tbdc, tbmovC, tbcumC]) await calculateAndAlert(o);
}, 900_000);

afterAll(() => {
  adminSql(`delete from public.organizations where name like 'ITest AuditReg %${RUN}';
    delete from auth.users where email like '%@${RUN}.auditreg.itest';`);
});

describe('H-1 · no bank data is not scored as banking', () => {
  it('HT-NOBANK: banking_health excluded every month; totals NULL / 87 / 87 (were 78 / 83 / 83)', () => {
    for (const ym of MONTHS) expect(banking(nobank, ym), ym).toBe('false|no_bank_coverage|skipped');
    // Jun: profitability 90 + cost control 70 = 2 dimensions → no score.
    // Jul/Aug: (95·25 + 65·15 + 95·15) / 55 = 86.8 → 87.
    expect(totals(nobank)).toEqual([null, 87, 87]);
  });

  it('HT-CSV (bank statements present): unchanged, 77 / 81 / 92, B4 full', () => {
    expect(totals(csv)).toEqual([77, 81, 92]);
    expect(banking(csv, '2026-08')).toBe('true||full');
  });
});

describe('H-2 · a trial balance states its P&L', () => {
  it('movement trial balance (attested, balancing): revenue 1,000 / 1,100 / 1,210, cost of sales and expenses likewise, verified', () => {
    expect(values(tbmovC, 'revenue')).toEqual(['1000.00', '1100.00', '1210.00']);
    expect(values(tbmovC, 'cost_of_sales')).toEqual(['400.00', '440.00', '484.00']);
    expect(values(tbmovC, 'operating_expenses')).toEqual(['300.00', '300.00', '300.00']);
    expect(values(tbmovC, 'net_profit')).toEqual(['300.00', '360.00', '426.00']);
    expect(metric(tbmovC, '2026-08', 'revenue')).toBe('1210.00|verified|period_balances|[]');
  });

  it('cumulative trial balance (attested, balancing): NULL no_prior_trial_balance / 1,100 / 1,210 — never a zero', () => {
    expect(values(tbcumC, 'revenue')).toEqual(['NULL', '1100.00', '1210.00']);
    expect(metric(tbcumC, '2026-06', 'revenue')).toContain('no_prior_trial_balance');
    expect(values(tbcumC, 'operating_expenses')).toEqual(['NULL', '300.00', '300.00']);
  });

  it('the auditor\'s unattested extracts: stated lines still state revenue and cost of sales', () => {
    expect(values(tbmov, 'revenue')).toEqual(['1000.00', '1100.00', '1210.00']);
    expect(values(tbmov, 'cost_of_sales')).toEqual(['400.00', '440.00', '484.00']);
    expect(values(tbcum, 'revenue')).toEqual(['NULL', '1100.00', '1210.00']);
    expect(metric(tbcum, '2026-06', 'revenue')).toContain('no_prior_trial_balance');
  });

  it('…and what they have no line for is NULL category_not_in_report, so expenses and net profit are NULL, never inferred (N-1)', () => {
    for (const o of [tbmov, tbdc]) {
      expect(values(o, 'operating_expenses')).toEqual(['NULL', 'NULL', 'NULL']);
      expect(values(o, 'net_profit')).toEqual(['NULL', 'NULL', 'NULL']);
      expect(metric(o, '2026-08', 'operating_expenses')).toContain('category_not_in_report');
    }
    expect(values(tbcum, 'operating_expenses')).toEqual(['NULL', 'NULL', 'NULL']);
  });

  it('the debit/credit totals the auditor filled in are not what the figure reads', () => {
    expect(values(tbdc, 'revenue')).toEqual(['1000.00', '1100.00', '1210.00']);
  });

  it('Health on an attested trial balance with no bank: NULL / 87 / 87 movement, NULL / NULL / 87 cumulative (by hand)', () => {
    // Same P&L as HT-NOBANK, so the same dimensions and totals.
    expect(totals(tbmovC)).toEqual([null, 87, 87]);
    // Cumulative: June has no P&L; July's growth needs June's revenue → 2 dimensions; August as above.
    expect(totals(tbcumC)).toEqual([null, null, 87]);
  });

  it('Health on the unattested extracts: no score any month — only revenue growth is computable (< 3 dimensions)', () => {
    // Profitability needs net_margin and cost control needs operating_expenses (health/domain/rules); both NULL.
    for (const o of [tbmov, tbdc, tbcum]) expect(totals(o)).toEqual([null, null, null]);
  });
});
