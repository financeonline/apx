import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money/decimal';
import { orgCollection, orgRow } from '@/db/schema';
import { calculateAndAlert, currentSnapshots, periodId } from '../fixtures/adr120-orgs';
import { balanceBatch, glBatch, type GlLine } from '../fixtures/audit-orgs';
import { bankAccount, statement } from '../fixtures/step0d-orgs';
import { removeSeeded } from '../fixtures/seed';
import { clientFor, createAuthUser, fs, rpc } from './setup';
import { dropOrg } from './tenancy-fixtures';

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
const DOMAIN = `${RUN}.auditreg.itest.motion`;
const orgs: string[] = [];

async function org(label: string): Promise<string> {
  const owner = await createAuthUser(`${label.toLowerCase()}@${DOMAIN}`);
  const r = await rpc<string>(clientFor(owner), 'create_organization', { p_name: `ITest AuditReg ${label} ${RUN}` });
  if (r.error) throw new Error(r.error.message);
  orgs.push(r.data!);
  return r.data!;
}

const MONTHS = ['2026-06', '2026-07', '2026-08'] as const;
const END: Record<string, string> = { '2026-06': '2026-06-30', '2026-07': '2026-07-31', '2026-08': '2026-08-31' };
const R: Record<string, string> = { '2026-06': '1000', '2026-07': '1100', '2026-08': '1210' };
const C: Record<string, string> = { '2026-06': '400', '2026-07': '440', '2026-08': '484' };
const O: Record<string, string> = { '2026-06': '300', '2026-07': '300', '2026-08': '300' };

async function htLedger(o: string): Promise<void> {
  for (const ym of MONTHS) {
    const lines: GlLine[] = [
      { date: `${ym}-05`, category: 'cash', direction: 'debit', amount: R[ym]! },
      { date: `${ym}-05`, category: 'revenue', direction: 'credit', amount: R[ym]! },
      { date: `${ym}-12`, category: 'cost_of_sales', direction: 'debit', amount: C[ym]! },
      { date: `${ym}-12`, category: 'cash', direction: 'credit', amount: C[ym]! },
      { date: `${ym}-25`, category: 'operating_expense', direction: 'debit', amount: O[ym]! },
      { date: `${ym}-25`, category: 'cash', direction: 'credit', amount: O[ym]! },
    ];
    await glBatch(o, { start: `${ym}-01`, end: END[ym]!, lines, tag: `ar-gl-${ym}` });
  }
}

async function htBank(o: string): Promise<void> {
  const bank = await bankAccount(o, 'Main');
  const moves = (ym: string): Array<[string, string]> => [[`${ym}-05`, R[ym]!], [`${ym}-12`, `-${C[ym]!}`], [`${ym}-25`, `-${O[ym]!}`]];
  await statement(o, bank, { start: '2026-06-01', end: '2026-06-30', extraction: 'csv', opening: '5000', closing: '5300', moves: moves('2026-06'), tag: 'ar-jun' });
  await statement(o, bank, { start: '2026-07-01', end: '2026-07-31', extraction: 'csv', moves: moves('2026-07'), tag: 'ar-jul' });
  await statement(o, bank, { start: '2026-08-01', end: '2026-08-31', extraction: 'csv', moves: moves('2026-08'), tag: 'ar-aug' });
}

/** The current Health Score document of a month, or null. */
async function healthOf(o: string, ym: string): Promise<Record<string, unknown> | null> {
  const current = await orgRow(fs(), o, 'health_current', periodId(o, `${ym}-01`)).get();
  if (!current.exists) return null;
  const score = await orgRow(fs(), o, 'health_scores', String(current.get('health_score_id'))).get();
  return score.exists ? score.data()! : null;
}

/** Current total per month, Jun → Aug (null where no score or a null score). */
async function totals(o: string): Promise<Array<number | null>> {
  const out: Array<number | null> = [];
  for (const ym of MONTHS) {
    const h = await healthOf(o, ym);
    out.push(h === null || h.score === null || h.score === undefined ? null : Number(h.score));
  }
  return out;
}

/** `included|exclusion_reason|B4 result` of banking_health in a month. */
async function banking(o: string, ym: string): Promise<string> {
  const h = await healthOf(o, ym);
  const d = ((h?.breakdown ?? []) as Array<Record<string, unknown>>).find((x) => x.key === 'banking_health');
  if (!d) return '';
  const b4 = ((d.rules ?? []) as Array<Record<string, unknown>>).find((r) => r.rule === 'B4');
  return `${String(d.included)}|${(d.exclusion_reason as string | null) ?? ''}|${(b4?.result as string | undefined) ?? ''}`;
}

/** `value|assurance|basis|missing` of the current headline snapshot (value to two places, as `numeric(16,2)`). */
async function metric(o: string, ym: string, key: string): Promise<string> {
  const s = (await currentSnapshots(o, `${ym}-01`, key))[0];
  if (!s) return '';
  const value = s.value === null || s.value === undefined ? 'NULL' : new Decimal(String(s.value)).toFixed(2);
  const missing = ((s.data_quality ?? {}) as { missing?: unknown }).missing ?? [];
  return `${value}|${String(s.assurance_level)}|${String(s.basis)}|${JSON.stringify(missing).replace(/,/g, ', ')}`;
}
const values = async (o: string, key: string) => {
  const out: string[] = [];
  for (const ym of MONTHS) out.push((await metric(o, ym, key)).split('|')[0]!);
  return out;
};

let csv: string; let nobank: string; let tbmov: string; let tbcum: string; let tbdc: string; let tbmovC: string; let tbcumC: string;

beforeAll(async () => {
  csv = await org('HTCSV'); await htLedger(csv); await htBank(csv);
  nobank = await org('HTNOBANK'); await htLedger(nobank);
  tbmov = await org('TBMOV'); tbcum = await org('TBCUM'); tbdc = await org('TBDC');
  const cum: Record<string, [string, string, string]> = { '2026-06': ['-1000', '400', '300'], '2026-07': ['-2100', '840', '600'], '2026-08': ['-3310', '1324', '900'] };
  for (const ym of MONTHS) {
    await balanceBatch(tbmov, { importType: 'trial_balance', basis: 'movement', start: `${ym}-01`, end: END[ym]!, tag: `rm-${ym}`,
      rows: [['revenue', `-${R[ym]!}`], ['cost_of_sales', C[ym]!], ['operating_expense', O[ym]!]] });
    const [r, c, o] = cum[ym]!;
    await balanceBatch(tbcum, { importType: 'trial_balance', basis: 'cumulative', start: `${ym}-01`, end: END[ym]!, tag: `rc-${ym}`,
      rows: [['revenue', r], ['cost_of_sales', c], ['operating_expense', o]] });
    await balanceBatch(tbdc, { importType: 'trial_balance', basis: 'movement', start: `${ym}-01`, end: END[ym]!, tag: `rd-${ym}`,
      rows: [['revenue', `-${R[ym]!}`], ['cost_of_sales', C[ym]!], ['operating_expense', O[ym]!]] });
  }
  // N-1: the same lines, balanced by an Equity line and attested complete.
  tbmovC = await org('TBMOVC'); tbcumC = await org('TBCUMC');
  for (const ym of MONTHS) {
    const eqMov = `${Number(R[ym]!) - Number(C[ym]!) - Number(O[ym]!)}`;
    await balanceBatch(tbmovC, { importType: 'trial_balance', basis: 'movement', start: `${ym}-01`, end: END[ym]!, tag: `rmc-${ym}`, complete: true,
      rows: [['revenue', `-${R[ym]!}`], ['cost_of_sales', C[ym]!], ['operating_expense', O[ym]!], ['equity', eqMov]] });
    const [r, c, o] = cum[ym]!;
    const eqCum = `${-(Number(r) + Number(c) + Number(o))}`;
    await balanceBatch(tbcumC, { importType: 'trial_balance', basis: 'cumulative', start: `${ym}-01`, end: END[ym]!, tag: `rcc-${ym}`, complete: true,
      rows: [['revenue', r], ['cost_of_sales', c], ['operating_expense', o], ['equity', eqCum]] });
  }
  // The auditor's control: debit/credit totals filled. They must no longer matter.
  const balances = await orgCollection(fs(), tbdc, 'period_balances').get();
  for (const b of balances.docs) {
    const closing = new Decimal(String(b.get('closing_balance')));
    await b.ref.update({
      debit_total: Decimal.max(closing, 0).toFixed(), credit_total: Decimal.max(closing.neg(), 0).toFixed(),
    });
  }
  for (const o of [csv, nobank, tbmov, tbcum, tbdc, tbmovC, tbcumC]) await calculateAndAlert(o);
}, 900_000);

afterAll(async () => {
  for (const o of orgs) await dropOrg(o);
  await removeSeeded([], DOMAIN);
});

describe('H-1 · no bank data is not scored as banking', () => {
  it('HT-NOBANK: banking_health excluded every month; totals NULL / 87 / 87 (were 78 / 83 / 83)', async () => {
    for (const ym of MONTHS) expect(await banking(nobank, ym), ym).toBe('false|no_bank_coverage|skipped');
    // Jun: profitability 90 + cost control 70 = 2 dimensions → no score.
    // Jul/Aug: (95·25 + 65·15 + 95·15) / 55 = 86.8 → 87.
    expect(await totals(nobank)).toEqual([null, 87, 87]);
  });

  it('HT-CSV (bank statements present): unchanged, 77 / 81 / 92, B4 full', async () => {
    expect(await totals(csv)).toEqual([77, 81, 92]);
    expect(await banking(csv, '2026-08')).toBe('true||full');
  });
});

describe('H-2 · a trial balance states its P&L', () => {
  it('movement trial balance (attested, balancing): revenue 1,000 / 1,100 / 1,210, cost of sales and expenses likewise, verified', async () => {
    expect(await values(tbmovC, 'revenue')).toEqual(['1000.00', '1100.00', '1210.00']);
    expect(await values(tbmovC, 'cost_of_sales')).toEqual(['400.00', '440.00', '484.00']);
    expect(await values(tbmovC, 'operating_expenses')).toEqual(['300.00', '300.00', '300.00']);
    expect(await values(tbmovC, 'net_profit')).toEqual(['300.00', '360.00', '426.00']);
    expect(await metric(tbmovC, '2026-08', 'revenue')).toBe('1210.00|verified|period_balances|[]');
  });

  it('cumulative trial balance (attested, balancing): NULL no_prior_trial_balance / 1,100 / 1,210 — never a zero', async () => {
    expect(await values(tbcumC, 'revenue')).toEqual(['NULL', '1100.00', '1210.00']);
    expect(await metric(tbcumC, '2026-06', 'revenue')).toContain('no_prior_trial_balance');
    expect(await values(tbcumC, 'operating_expenses')).toEqual(['NULL', '300.00', '300.00']);
  });

  it('the auditor\'s unattested extracts: stated lines still state revenue and cost of sales', async () => {
    expect(await values(tbmov, 'revenue')).toEqual(['1000.00', '1100.00', '1210.00']);
    expect(await values(tbmov, 'cost_of_sales')).toEqual(['400.00', '440.00', '484.00']);
    expect(await values(tbcum, 'revenue')).toEqual(['NULL', '1100.00', '1210.00']);
    expect(await metric(tbcum, '2026-06', 'revenue')).toContain('no_prior_trial_balance');
  });

  it('…and what they have no line for is NULL report_completeness_unconfirmed, so expenses and net profit are NULL, never inferred (N-1)', async () => {
    for (const o of [tbmov, tbdc]) {
      expect(await values(o, 'operating_expenses')).toEqual(['NULL', 'NULL', 'NULL']);
      expect(await values(o, 'net_profit')).toEqual(['NULL', 'NULL', 'NULL']);
      // Never answered (an import made before the question existed): a confirmation is still possible.
      expect(await metric(o, '2026-08', 'operating_expenses')).toContain('report_completeness_unconfirmed');
    }
    expect(await values(tbcum, 'operating_expenses')).toEqual(['NULL', 'NULL', 'NULL']);
  });

  it('the debit/credit totals the auditor filled in are not what the figure reads', async () => {
    expect(await values(tbdc, 'revenue')).toEqual(['1000.00', '1100.00', '1210.00']);
  });

  it('Health on an attested trial balance with no bank: NULL / 87 / 87 movement, NULL / 82 / 84 cumulative (by hand)', async () => {
    // Same P&L as HT-NOBANK, so the same dimensions and totals. A movement trial balance states no
    // debt (debt reads a cumulative statement), so funding readiness is excluded here (v5, ADR-147):
    // Jul/Aug (95·44.7 + 65·27.7 + 95·27.7) / 100.1 = 86.7 → 87.
    expect(await totals(tbmovC)).toEqual([null, 87, 87]);
    /*
     * Cumulative, health.config.v5 (ADR-147). The attested, balancing cumulative statement has no
     * borrowing line, so debt is a KNOWN zero (ADR-145 §4) and funding readiness is included:
     * R1 no debt +25, R2 no figure three months back (skipped), R3/R4 no aging (skipped), R5 one
     * (Jul) then two (Aug) complete months of six → −10: 50 + 25 − 10 = 65.
     *   June: no P&L at all → only funding readiness → fewer than three dimensions → NULL.
     *   July: profitability 90, cost control 80, funding 65; weights 21/13/8 of 42 → 50.0/31.0/19.0;
     *         (90·50 + 80·31 + 65·19) / 100 = 82.15 → 82.
     *   Aug:  profitability 95, revenue growth 65, cost control 95, funding 65; 21/13/13/8 of 55 →
     *         38.2/23.6/23.6/14.5; (95·38.2 + 65·23.6 + 95·23.6 + 65·14.5) / 99.9 = 83.56 → 84.
     * Under v4 these were NULL / NULL / 87.
     */
    expect(await totals(tbcumC)).toEqual([null, 82, 84]);
  });

  it('Health on the unattested extracts: no score any month — only revenue growth is computable (< 3 dimensions)', async () => {
    // Profitability needs net_margin and cost control needs operating_expenses (health/domain/rules); both NULL.
    for (const o of [tbmov, tbdc, tbcum]) expect(await totals(o)).toEqual([null, null, null]);
  });
});
