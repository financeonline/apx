import { describe, expect, it } from 'vitest';
import { FUNDING_RULES } from '@/modules/funding';
import {
  FUNDING_READINESS_RULES, computeHealthScore, evaluateFundingReadiness, evaluateMarketingEfficiency,
  type HealthCommercial, type HealthInvoice,
} from '@/modules/health';
import { healthInput, snapshot } from '../fixtures/health';

/**
 * health.config.v5's two dimensions (ADR-147). Every expected figure is worked by hand from the rows
 * beside it, and the funding readiness thresholds are proved to be the approved Funding Readiness
 * ones rather than restated.
 */

const months = (n: number) => Array.from({ length: n }, (_, i) => `p-${String(i + 1).padStart(2, '0')}`);
const startOf = (p: string) => `2026-${p.slice(2)}-01`;
const endOf = (p: string) => {
  const m = Number(p.slice(2));
  return `2026-${p.slice(2)}-${new Date(Date.UTC(2026, m, 0)).getUTCDate()}`;
};
const pnl = (p: string, operatingProfit: string, extra: Partial<Parameters<typeof snapshot>[0]> = {}) => [
  snapshot({ key: 'revenue', value: '10000', unit: 'money', periodId: p, ...extra }),
  snapshot({ key: 'operating_profit', value: operatingProfit, unit: 'money', periodId: p, ...extra }),
];
const money = (key: string, value: string | null, p: string, extra: Partial<Parameters<typeof snapshot>[0]> = {}) =>
  snapshot({ key, value, unit: 'money', periodId: p, ...extra });
const invoice = (invoiceType: HealthInvoice['invoiceType'], balanceDue: string, dueDate: string): HealthInvoice => ({
  invoiceType, issueDate: '2026-11-01', dueDate, totalAmount: balanceDue, balanceDue, paidDate: null,
});

describe('funding readiness reads the approved Funding Readiness thresholds (ADR-140, ADR-147)', () => {
  it('R1–R4 are F4.1, F4.2, F5.2 and F5.3 band for band', () => {
    expect(FUNDING_READINESS_RULES.R1.bands).toEqual(FUNDING_RULES['F4.1'].bands);
    expect(FUNDING_READINESS_RULES.R2.bands).toEqual(FUNDING_RULES['F4.2'].bands);
    expect(FUNDING_READINESS_RULES.R3.bands).toEqual(FUNDING_RULES['F5.2'].bands);
    expect(FUNDING_READINESS_RULES.R4.bands).toEqual(FUNDING_RULES['F5.3'].bands);
    expect(FUNDING_READINESS_RULES.R1.direction).toBe(FUNDING_RULES['F4.1'].direction);
  });
});

describe('the funding readiness dimension', () => {
  // Thirteen months, P = p-13 (December 2026, ending 2026-12-31 in this fixture's calendar).
  const P13 = months(13).map((p, i) => `p-${String(i + 1).padStart(2, '0')}`);
  const periodIds = P13;
  const P = 'p-13';
  const ends = new Map(P13.map((p) => [p, p === 'p-13' ? '2026-12-31' : endOf(p.replace('p-13', 'p-12'))]));
  const history = P13.slice(1).flatMap((p) => pnl(p, '2500')); // p-02 … p-13: twelve complete months
  const base = (over: Parameters<typeof healthInput>[0] = {}) => healthInput({
    periodId: P, periodIds, periodEnds: ends, ...over,
  });

  it('debt 1.0x a year of operating profit, falling; 60% of receivables overdue; six complete months: 75', () => {
    // T12M operating profit 12 × 2,500 = 30,000; debt 30,000 → 1.0x → +25 (<= 1.0x).
    // Debt three months earlier 40,000 → (30,000 − 40,000) / 40,000 = −25% → +10.
    // Open sales 12,000 overdue + 8,000 not → 60% → −20. No payables → R4 skipped. R5: six → +10.
    const snapshots = [
      ...history,
      money('debt_balance', '30000', P), money('debt_balance', '40000', 'p-10'),
      money('receivables', '20000', P),
      money('receivables_overdue', '12000', P, { components: { as_of: '2026-12-31' } }),
    ];
    const invoices = [invoice('sales', '12000', '2026-12-01'), invoice('sales', '8000', '2027-01-15'),
      invoice('sales_credit_note', '5000', '2026-12-01')];
    const e = evaluateFundingReadiness(base({ snapshots, invoices }));
    expect(e.rules.map((r) => [r.rule, r.points, r.skipped_reason ?? r.result])).toEqual([
      ['R1', 25, '<= 1.0x'], ['R2', 10, 'down 10% or more'], ['R3', -20, '50% or more'],
      ['R4', 0, 'value_unavailable'], ['R5', 10, '6'],
    ]);
    const score = computeHealthScore(base({ snapshots, invoices }))!;
    expect(score.breakdown.find((d) => d.key === 'funding_readiness')).toMatchObject({ included: true, score: 75 });
    expect(e.negatives.map((n) => n.text)).toContain('60.0% of what customers owe is overdue');
  });

  it('owes nothing, and owed nothing three months ago: +25 and 0', () => {
    const snapshots = [...history, money('debt_balance', '0', P), money('debt_balance', '0', 'p-10')];
    const e = evaluateFundingReadiness(base({ snapshots }));
    expect(e.rules.slice(0, 2).map((r) => [r.points, r.result])).toEqual([[25, 'no_debt'], [0, 'none either side']]);
  });

  it('new debt with no operating profit to carry it: −30 and −10', () => {
    const snapshots = [...P13.slice(1).flatMap((p) => pnl(p, '-100')), money('debt_balance', '5000', P), money('debt_balance', '0', 'p-10')];
    const e = evaluateFundingReadiness(base({ snapshots }));
    expect(e.rules.slice(0, 2).map((r) => [r.points, r.result])).toEqual([[-30, 'no_operating_profit'], [-10, 'new_debt']]);
  });

  it('eleven complete months is no capacity figure: R1 skipped, never guessed', () => {
    const snapshots = [...P13.slice(2).flatMap((p) => pnl(p, '2500')), money('debt_balance', '30000', P)];
    expect(evaluateFundingReadiness(base({ snapshots })).rules[0]).toMatchObject({ points: 0, skipped_reason: 'capacity_unavailable' });
  });

  it('unknown debt with receivables known: included on receivables, debt skipped', () => {
    const snapshots = [...history, money('receivables', '1000', P)];
    const score = computeHealthScore(base({ snapshots }))!;
    const d = score.breakdown.find((x) => x.key === 'funding_readiness')!;
    expect(d.included).toBe(true);
    expect(d.rules.slice(0, 2).map((r) => r.skipped_reason)).toEqual(['value_unavailable', 'value_unavailable']);
  });

  it('nothing outstanding is +10; aging with no invoices loaded is skipped', () => {
    const snapshots = [...history, money('receivables', '0', P),
      money('receivables_overdue', '0', P, { components: { as_of: '2026-12-31' } })];
    expect(evaluateFundingReadiness(base({ snapshots, invoices: [] })).rules[2]).toMatchObject({ points: 10, result: 'nothing_outstanding' });
    expect(evaluateFundingReadiness(base({ snapshots })).rules[2]).toMatchObject({ skipped_reason: 'aging_unavailable' });
  });

  it('is capped at 70 when the debt it read is estimated', () => {
    const snapshots = [
      ...history,
      money('debt_balance', '30000', P, { assurance: 'estimated' }), money('debt_balance', '40000', 'p-10'),
      money('receivables', '0', P), money('receivables_overdue', '0', P, { components: { as_of: '2026-12-31' } }),
    ];
    // 50 + 25 + 10 + 10 (nothing outstanding) + 10 = 105 → clamped 100 → capped 70.
    const d = computeHealthScore(base({ snapshots, invoices: [] }))!.breakdown.find((x) => x.key === 'funding_readiness')!;
    expect(d).toMatchObject({ included: true, score: 70, capped: true });
  });
});

describe('the marketing efficiency dimension', () => {
  const periodIds = months(6); // p-01 … p-06 = January … June 2026
  const P = 'p-06';
  const starts = new Map(periodIds.map((p) => [p, startOf(p)]));
  const ends = new Map(periodIds.map((p) => [p, endOf(p)]));
  const custRevenue = (customer: string, p: string, value: string) =>
    snapshot({ key: 'customer_revenue', value, unit: 'money', periodId: p, dimensionId: customer });
  const revenueRows = periodIds.map((p) => money('revenue', '20000', p));
  const won = (id: string, counterpartyId: string, campaignId: string | null, wonOn: string) =>
    ({ id, stage: 'won' as const, counterpartyId, campaignId, wonOn });
  const commercial = (over: Partial<HealthCommercial> = {}): HealthCommercial => ({
    spend: [
      { campaignId: 'c1', periodId: 'p-04', amount: '1000.00' }, { campaignId: 'c1', periodId: 'p-05', amount: '1000.00' },
      { campaignId: 'c1', periodId: 'p-06', amount: '1000.00' }, { campaignId: 'c1', periodId: 'p-02', amount: '2000.00' },
    ],
    opportunities: [
      won('o1', 'A', 'c1', '2026-05-10'), won('o2', 'B', 'c1', '2026-02-15'),
      won('o3', 'A', 'c2', '2026-06-01'), // A's later win: the earliest counts, once
      won('o4', 'D', null, '2026-05-01'), // won with no campaign: nobody's
      { id: 'o5', stage: 'lost', counterpartyId: 'C', campaignId: 'c1', wonOn: null },
    ],
    ...over,
  });
  const snapshots = [
    ...revenueRows,
    custRevenue('A', 'p-04', '5000'), custRevenue('A', 'p-05', '4000'), custRevenue('A', 'p-06', '3000'),
    custRevenue('B', 'p-04', '1000'), custRevenue('B', 'p-05', '1000'), custRevenue('B', 'p-06', '1000'),
    custRevenue('D', 'p-05', '9999'),
  ];
  const input = (over: Parameters<typeof healthInput>[0] = {}) => healthInput({
    periodId: P, periodIds, periodStarts: starts, periodEnds: ends, snapshots, commercial: commercial(), ...over,
  });

  it('3.3x back on spend, cost per customer up 50%: 50 + 20 − 10 = 60', () => {
    // Window April–June: spend 3,000. Revenue from campaign-won customers, from the month won:
    // A from May (4,000 + 3,000 — April's 5,000 is before the win), B all three months (3,000) → 10,000.
    // 10,000 / 3,000 = 3.33x → +20. Cost per customer: 3,000 / 1 (A, won 10 May) = 3,000; before,
    // January–March: 2,000 / 1 (B, won 15 Feb) = 2,000 → +50% → −10. D (no campaign) counts nowhere.
    const e = evaluateMarketingEfficiency(input());
    expect(e.rules.map((r) => [r.rule, r.points, r.result])).toEqual([['M1', 20, '>= 3x'], ['M2', -10, 'up 10% or more']]);
    expect(e.rules[0]!.value).toBe('3.333333');
    const d = computeHealthScore(input())!.breakdown.find((x) => x.key === 'marketing_efficiency')!;
    expect(d).toMatchObject({ included: true, score: 60 });
    expect(e.positives.map((p) => p.text)).toEqual(['Customers won by campaigns brought in 3.3x what the campaigns cost over three months']);
  });

  it('no campaign spend in the window is not scored — never "inefficient"', () => {
    const d = (over: Parameters<typeof healthInput>[0]) =>
      computeHealthScore(input(over))!.breakdown.find((x) => x.key === 'marketing_efficiency')!;
    expect(d({ commercial: commercial({ spend: [{ campaignId: 'c1', periodId: 'p-02', amount: '2000.00' }] }) }))
      .toMatchObject({ included: false, exclusion_reason: 'no_campaign_data' });
    expect(d({ commercial: undefined })).toMatchObject({ included: false, exclusion_reason: 'no_campaign_data' });
  });

  it('spend that won nobody, ever: 0x → −20, and the cost per customer is not a number', () => {
    const e = evaluateMarketingEfficiency(input({ commercial: commercial({ opportunities: [] }) }));
    expect(e.rules.map((r) => [r.points, r.skipped_reason ?? r.result])).toEqual([[-20, 'below 1x'], [0, 'no_customers_won']]);
    expect(e.negatives.map((n) => n.text)).toEqual(['Campaigns spent £3,000 over three months and won no customers']);
  });

  it('no spend in the three months before: M2 has nothing to compare with', () => {
    const spend = commercial().spend.filter((s) => s.periodId !== 'p-02');
    expect(evaluateMarketingEfficiency(input({ commercial: commercial({ spend }) })).rules[1])
      .toMatchObject({ skipped_reason: 'no_prior_window' });
  });
});
