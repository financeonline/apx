import { describe, expect, it } from 'vitest';
import { FUNDING_DISCLAIMER, FUNDING_RULES_VERSION, assessFundingReadiness, readinessBand, type FundingInput } from '@/modules/funding';
import type { MetricObservation } from '@/modules/alerts';

/**
 * Funding Readiness, `funding_readiness.v1` (PHASE_16_IMPLEMENTATION.md §4–§7, §14). Every expected
 * score is worked by hand from the rules beside it.
 */

const P = Array.from({ length: 13 }, (_, i) => `p${String(i).padStart(2, '0')}`); // p00 … p12, P = p12
const PERIOD = 'p12';

function obs(key: string, value: string | null, over: Partial<MetricObservation> & { periodId?: string } = {}): MetricObservation {
  return {
    snapshotId: `s-${key}-${over.periodId ?? PERIOD}`, periodId: PERIOD, metricKey: key, dimensionType: 'none', dimensionId: null,
    dimensionKey: null, value, unit: 'money', basis: 'ledger', assurance: 'verified', components: {},
    dataQuality: { completeness: 1, proxy: false, warnings: [], missing: value === null ? ['no_source_covers_period'] : [] },
    ...over,
  } as MetricObservation;
}

/** Twelve complete months of revenue 10,000 and operating profit 1,000, so F6 and T12M are defined. */
function history(): MetricObservation[] {
  return P.slice(1).flatMap((p) => [obs('revenue', '10000', { periodId: p }), obs('operating_profit', '1000', { periodId: p })]);
}

/** A business that scores on every factor, with a strong position. */
function strong(): MetricObservation[] {
  return [
    ...history().filter((o) => o.periodId !== PERIOD),
    obs('revenue', '10000'), obs('operating_profit', '1000'), obs('net_profit', '2000'), obs('net_margin', '0.20', { unit: 'ratio' }),
    obs('revenue_growth_yoy', '0.25', { unit: 'ratio' }), obs('gross_margin', '0.55', { unit: 'ratio' }),
    obs('closing_cash', '50000', { basis: 'bank' }), obs('net_cash_movement', '1000', { basis: 'bank' }),
    obs('cash_runway_months', '12', { unit: 'count' }), obs('cash_outflows', '5000', { basis: 'bank' }), obs('cash_inflows', '6000', { basis: 'bank' }),
    ...['p10', 'p11'].map((p) => obs('net_cash_movement', '500', { periodId: p, basis: 'bank' })),
    obs('debt_balance', '0', { basis: 'period_balances' }), obs('debt_balance', '0', { periodId: 'p09', basis: 'period_balances' }),
    obs('receivables', '3000'), obs('receivables_overdue', '0'), obs('receivables_days', '20', { unit: 'days' }),
    obs('payables', '2000'), obs('payables_overdue', '0'),
  ];
}

const input = (snapshots: MetricObservation[], over: Partial<FundingInput> = {}): FundingInput => ({
  periodId: PERIOD, periodEnd: '2026-08-31', periodIds: P, currency: 'GBP', snapshots,
  bankEvidence: new Map(P.map((p) => [p, 1])),
  anomalies: { suppressed: false, reason: null, count: 0 },
  reconciliation: [{ accountId: 'a', name: 'Current', status: 'reconciled' }],
  loanBankAccountNames: [],
  openInvoices: [{ invoiceType: 'sales', issueDate: '2026-08-01', dueDate: '2026-09-15', outstanding: '3000' }],
  ...over,
});

const factor = (a: ReturnType<typeof assessFundingReadiness>, key: string) => a.factors.find((f) => f.key === key)!;
const rule = (a: ReturnType<typeof assessFundingReadiness>, key: string) =>
  a.factors.flatMap((f) => f.rules).find((r) => r.rule === key)!;
const without = (keys: string[], periodId = PERIOD) => strong().filter((o) => !(keys.includes(o.metricKey) && o.periodId === periodId));

describe('the factor contract (§4)', () => {
  it('sums every rule and clamps ONCE: F1 50 + 30 + 30 + 10 = 120 → 100', () => {
    const a = assessFundingReadiness(input(strong()));
    expect(factor(a, 'F1')).toMatchObject({ status: 'scored', score: 100 });
    expect(factor(a, 'F1').rules.map((r) => r.points)).toEqual([30, 30, 10]);
  });

  it('a factor below zero clamps to 0 once, never per rule', () => {
    // F2: cash −100 → −40; runway 0.5 → −30; three falls → −20; cover negative → −10: 50 − 100 = −50 → 0.
    const snaps = [...without(['closing_cash', 'cash_runway_months', 'net_cash_movement']),
      obs('closing_cash', '-100', { basis: 'bank' }), obs('cash_runway_months', '0.5', { unit: 'count' }), obs('net_cash_movement', '-1', { basis: 'bank' }),
      ...['p10', 'p11'].map((p) => obs('net_cash_movement', '-1', { periodId: p, basis: 'bank' }))]
      .filter((o) => !(o.metricKey === 'net_cash_movement' && o.value === '500'));
    const a = assessFundingReadiness(input(snaps));
    expect(factor(a, 'F2').rules.map((r) => r.points)).toEqual([-40, -30, -20, -10]);
    expect(factor(a, 'F2').score).toBe(0);
  });

  it('a factor with a required input missing is unavailable, scored NULL — never 0', () => {
    const a = assessFundingReadiness(input(without(['net_profit'])));
    expect(factor(a, 'F1')).toMatchObject({ status: 'missing', score: null, reason: 'required_input_missing' });
  });

  it('thin required inputs (completeness < 0.6) exclude the factor', () => {
    const thin = strong().map((o) => (o.metricKey === 'revenue' && o.periodId === PERIOD
      ? { ...o, dataQuality: { ...o.dataQuality, completeness: 0.5 } } : o));
    expect(factor(assessFundingReadiness(input(thin)), 'F1')).toMatchObject({ status: 'missing', reason: 'insufficient_completeness' });
  });

  it('caps a factor on bank-proxy inputs at 70, saying why', () => {
    const proxy = strong().map((o) => (['revenue', 'net_profit'].includes(o.metricKey) && o.periodId === PERIOD
      ? { ...o, basis: 'bank' as const, dataQuality: { ...o.dataQuality, proxy: true } } : o));
    expect(factor(assessFundingReadiness(input(proxy)), 'F1')).toMatchObject({ score: 70, capped: true, capReason: 'based on bank data only' });
  });
});

describe('F1 revenue and profitability (A-4)', () => {
  it('revenue at or below zero scores −30 and calculates no margin or growth', () => {
    const a = assessFundingReadiness(input([...without(['revenue']), obs('revenue', '0')]));
    expect(factor(a, 'F1').rules.map((r) => [r.rule, r.points, r.unavailable])).toEqual([
      ['F1.1', -30, null], ['F1.2', 0, 'no_revenue'], ['F1.3', 0, 'no_revenue'],
    ]);
    expect(factor(a, 'F1').score).toBe(20);
  });

  it('falls back from year-on-year to month-on-month growth, and says so when neither exists', () => {
    const mom = assessFundingReadiness(input([...without(['revenue_growth_yoy']), obs('revenue_growth_mom', '0.10', { unit: 'ratio' })]));
    expect(rule(mom, 'F1.2')).toMatchObject({ points: 15 });
    expect(rule(assessFundingReadiness(input(without(['revenue_growth_yoy']))), 'F1.2')).toMatchObject({ unavailable: 'no_comparable_period' });
  });
});

describe('F2 cash flow', () => {
  it('a NULL runway the engine calls cash-positive scores +20', () => {
    const a = assessFundingReadiness(input([...without(['cash_runway_months']),
      obs('cash_runway_months', null, { dataQuality: { completeness: 1, proxy: false, warnings: ['cash_positive'], missing: [] } as never })]));
    expect(rule(a, 'F2.2')).toMatchObject({ band: 'cash generative', points: 20 });
  });

  it('a month whose statements do not fully cover it is not read as a fall (A-5)', () => {
    const a = assessFundingReadiness(input(strong(), { bankEvidence: new Map(P.map((p) => [p, p === 'p10' ? 0.5 : 1])) }));
    expect(rule(a, 'F2.3')).toMatchObject({ unavailable: 'insufficient_history', points: 0 });
  });

  it('no bank account: cash is unavailable, never zero cash', () => {
    const a = assessFundingReadiness(input(without(['closing_cash', 'net_cash_movement'])));
    expect(factor(a, 'F2')).toMatchObject({ status: 'missing', score: null });
  });
});

describe('F3 banking behaviour', () => {
  it('no cash-like account in scope is unavailable — never "full" coverage (H-1)', () => {
    const a = assessFundingReadiness(input(strong(), { bankEvidence: new Map(P.map((p) => [p, null])) }));
    expect(factor(a, 'F3')).toMatchObject({ status: 'missing', reason: 'no_bank_coverage' });
  });

  it('a missing statement in P lowers F3.3 only — not F3.4 or F3.5 (§5.9)', () => {
    const a = assessFundingReadiness(input(strong(), {
      bankEvidence: new Map(P.map((p) => [p, p === PERIOD ? 0.5 : 1])),
      reconciliation: [{ accountId: 'a', name: 'Current', status: 'reconciled' }],
    }));
    expect(rule(a, 'F3.3').points).toBe(-5);
    expect(rule(a, 'F3.4').points).toBe(10);
    expect(rule(a, 'F3.5').points).toBe(10);
  });

  it('statement history counts the five months BEFORE P (A-1)', () => {
    const gaps = new Map(P.map((p) => [p, ['p07', 'p08', 'p09'].includes(p) ? 0 : 1]));
    expect(rule(assessFundingReadiness(input(strong(), { bankEvidence: gaps })), 'F3.5')).toMatchObject({ value: '2', points: -10 });
  });

  it('suppressed anomaly rules are unavailable with their reason, never "none found"', () => {
    const a = assessFundingReadiness(input(strong(), { anomalies: { suppressed: true, reason: 'no_record_data', count: 0 } }));
    expect(rule(a, 'F3.2')).toMatchObject({ unavailable: 'no_record_data', points: 0 });
  });
});

describe('F4 existing debt (U-3)', () => {
  it('no debt scores +25 whatever the operating profit', () => {
    expect(rule(assessFundingReadiness(input(strong())), 'F4.1')).toMatchObject({ band: 'no_debt', points: 25 });
  });

  it('debt with twelve months of operating profit is banded by the ratio: 24,000 ÷ 12,000 = 2.0x → +10', () => {
    const snaps = [...without(['debt_balance']), obs('debt_balance', '24000', { basis: 'period_balances' })];
    expect(rule(assessFundingReadiness(input(snaps)), 'F4.1')).toMatchObject({ value: '2.000000', points: 10 });
  });

  it('debt with twelve months of losses scores −30 without dividing', () => {
    const losses = strong().map((o) => (o.metricKey === 'operating_profit' ? { ...o, value: '-10' } : o));
    const snaps = [...losses.filter((o) => !(o.metricKey === 'debt_balance' && o.periodId === PERIOD)), obs('debt_balance', '5000', { basis: 'period_balances' })];
    expect(rule(assessFundingReadiness(input(snaps)), 'F4.1')).toMatchObject({ band: 'no_operating_profit', points: -30, value: null });
  });

  it('debt with fewer than twelve complete months is unavailable, not −30', () => {
    const short = [...without(['debt_balance']).filter((o) => o.periodId !== 'p01'), obs('debt_balance', '5000', { basis: 'period_balances' })];
    expect(rule(assessFundingReadiness(input(short)), 'F4.1')).toMatchObject({ unavailable: 'capacity_unavailable' });
  });

  it('unknown debt makes the whole factor unavailable — no no-debt score — and names a loan account only as a hint', () => {
    const a = assessFundingReadiness(input(without(['debt_balance']), { loanBankAccountNames: ['Business Loan'] }));
    const f4 = factor(a, 'F4');
    expect(f4).toMatchObject({ status: 'missing', score: null, reason: 'no_balance_sheet' });
    expect(f4.missing.map((m) => m.text)).toContain('Debt could not be established from the available balance-sheet data.');
    expect(f4.missing.some((m) => m.text.includes('Business Loan'))).toBe(true);
    expect(a.actions.map((x) => x.text)).toContain('Import a trial balance or balance sheet so debt can be established.');
  });

  it('new borrowing in three months scores −10', () => {
    const snaps = [...without(['debt_balance']), obs('debt_balance', '1000', { basis: 'period_balances' })];
    expect(rule(assessFundingReadiness(input(snaps)), 'F4.2')).toMatchObject({ band: 'new_debt', points: -10 });
  });
});

describe('F5 receivables and payables', () => {
  it('both sides unknown is unavailable — never "nothing outstanding"', () => {
    const a = assessFundingReadiness(input(without(['receivables', 'payables', 'receivables_overdue', 'payables_overdue', 'receivables_days'])));
    expect(factor(a, 'F5')).toMatchObject({ status: 'missing', score: null });
  });

  it('the overdue share is over GROSS open invoices: 1,000 overdue of 4,000 open = 25% → +10', () => {
    const a = assessFundingReadiness(input([...without(['receivables_overdue']), obs('receivables_overdue', '1000', { components: { as_of: '2026-08-31' } })], {
      openInvoices: [
        { invoiceType: 'sales', issueDate: '2026-07-01', dueDate: '2026-08-01', outstanding: '1000' },
        { invoiceType: 'sales', issueDate: '2026-08-10', dueDate: '2026-09-10', outstanding: '3000' },
        // A credit note is stated apart, never netted into the denominator (ADR-140).
        { invoiceType: 'sales_credit_note', issueDate: '2026-08-11', dueDate: null, outstanding: '-900' },
      ],
    }));
    expect(rule(a, 'F5.2')).toMatchObject({ value: '0.250000', points: 10 });
  });

  it('no ageing (a balance-sheet figure) is unavailable for the share', () => {
    const a = assessFundingReadiness(input([...without(['receivables_overdue']), obs('receivables_overdue', null)]));
    expect(rule(a, 'F5.2')).toMatchObject({ unavailable: 'aging_unavailable' });
  });
});

describe('F6 financial consistency', () => {
  it('a missing month lowers continuity only, and is never counted as a loss', () => {
    const a = assessFundingReadiness(input(without(['revenue', 'operating_profit'], 'p09')));
    expect(rule(a, 'F6.1')).toMatchObject({ value: '5', points: 0 });
    expect(rule(a, 'F6.2')).toMatchObject({ unavailable: 'insufficient_history' });
    expect(rule(a, 'F6.3')).toMatchObject({ unavailable: 'insufficient_history' });
  });

  it('six steady, profitable months: +10 +10 +15 → 85', () => {
    expect(factor(assessFundingReadiness(input(strong())), 'F6').score).toBe(85);
  });
});

describe('F7 data completeness is diagnostic', () => {
  it('excludes cash-family completeness (A-2) and never counts towards the gate', () => {
    const a = assessFundingReadiness(input(strong()));
    expect(factor(a, 'F7').status).toBe('scored');
    const noF7 = assessFundingReadiness(input(without(['net_profit', 'closing_cash', 'net_cash_movement'])));
    // F1 and F2 missing: F7 scored does not rescue the gate.
    expect(noF7.status).toBe('insufficient_data');
  });
});

describe('the gate and the overall score (§6)', () => {
  it('scores a business with every factor, and rounds half up', () => {
    const a = assessFundingReadiness(input(strong()));
    expect(a).toMatchObject({ status: 'scored', factorsUsed: 7, factorsTotal: 7, substantiveWeightScored: 90, dataCoveragePercent: 100 });
    expect(a.score).not.toBeNull();
    expect(a.band).toBe(readinessBand(a.score));
    expect(a.disclaimer).toBe(FUNDING_DISCLAIMER);
    expect(a.rulesVersion).toBe(FUNDING_RULES_VERSION);
  });

  it('needs F1 and F2: without F2 there is no number at all', () => {
    const a = assessFundingReadiness(input(without(['closing_cash', 'net_cash_movement'])));
    expect(a).toMatchObject({ status: 'insufficient_data', score: null, band: null });
    // The cards, missing lines and actions still show.
    expect(a.factors.filter((f) => f.status === 'scored').length).toBeGreaterThan(0);
  });

  it('F1 + F2 + three of F3–F6 is enough: debt unknown, 75 of 90, still scores (design gate table, "Invoices + bank")', () => {
    const a = assessFundingReadiness(input(without(['debt_balance'])));
    expect(a).toMatchObject({ status: 'scored', substantiveWeightScored: 75, dataCoveragePercent: 83 });
  });

  it('…but F1 + F2 + two of F3–F6 is not: debt and receivables/payables both unknown (65 of 90)', () => {
    const a = assessFundingReadiness(input(without(['debt_balance', 'receivables', 'payables', 'receivables_overdue', 'payables_overdue', 'receivables_days'])));
    expect(a).toMatchObject({ status: 'insufficient_data', score: null, substantiveWeightScored: 65 });
  });

  it('bands at their bounds', () => {
    expect([39, 40, 59, 60, 74, 75, 89, 90].map(readinessBand)).toEqual([
      'Low indicative readiness', 'Developing indicative readiness', 'Developing indicative readiness', 'Moderate indicative readiness',
      'Moderate indicative readiness', 'Strong indicative readiness', 'Strong indicative readiness', 'High indicative readiness',
    ]);
  });

  it('orders actions by priority, then factor weight', () => {
    const snaps = [...without(['closing_cash']), obs('closing_cash', '-100', { basis: 'bank' })];
    const priorities = assessFundingReadiness(input(snaps)).actions.map((x) => x.priority);
    expect([...priorities]).toEqual([...priorities].sort((a, b) => ['high', 'medium', 'low'].indexOf(a) - ['high', 'medium', 'low'].indexOf(b)));
  });

  it('is byte-identical for the same snapshots in any order', () => {
    const one = assessFundingReadiness(input(strong()));
    const two = assessFundingReadiness(input([...strong()].reverse()));
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });
});

describe('Funding Readiness is a department (ADR-173)', () => {
  it('is absent for a team member whose departments leave it out, without asking the database', async () => {
    const { fundingEnabled } = await import('@/modules/funding');
    // A 3rd party starts with the Reports department only. `db` is never read: had the company's
    // switch been consulted, this would throw.
    const ctx = {
      orgId: 'org-1', modules: new Set(['reports']),
      db: new Proxy({}, { get: () => { throw new Error('the database was read'); } }),
    } as unknown as Parameters<typeof fundingEnabled>[0];
    await expect(fundingEnabled(ctx)).resolves.toBe(false);
  });
});
