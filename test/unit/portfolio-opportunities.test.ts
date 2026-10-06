import { describe, expect, it } from 'vitest';
import {
  OPPORTUNITY_THRESHOLDS as T, opportunitiesFor, opportunityEntry,
  type BreakdownDimension, type ClientBreakdown, type PortfolioHealth,
} from '@/modules/portfolio';

/**
 * Advisory opportunities (SOW §20, REQ-AD-10; ADR-148). Pure: the same breakdown always gives the same
 * list. Each rule is tested at its threshold and just past it, from the stored shapes the database
 * function returns.
 */

const dim = (key: string, score: number | null, rules: Array<[string, number, string | null, string | null]> = []): BreakdownDimension => ({
  key, included: score !== null, score,
  rules: rules.map(([rule, points, result, value]) => ({ rule, points, result, value, skipped: null })),
});
const breakdown = (...dimensions: BreakdownDimension[]): ClientBreakdown => ({
  organizationId: 'o', healthScoreId: 'hs', periodLabel: 'Aug 2026', configVersion: 'health.config.v5',
  evidenceBundleId: 'eb', dimensions,
});
const band = (s: number) => (s >= 80 ? 'strong' : s >= 60 ? 'stable' : s >= 40 ? 'needs_attention' : 'at_risk') as PortfolioHealth['band'];
const health = (score: number, previous: number | null = null): PortfolioHealth => ({
  organizationId: 'o', scoreId: 'hs', periodId: 'p', periodStart: '2026-08-01', periodLabel: 'Aug 2026',
  score, band: band(score), dimensionsUsed: 8, dimensionsTotal: 8,
  previous: previous === null ? null : { periodStart: '2026-07-01', periodLabel: 'Jul 2026', score: previous, band: band(previous) },
});
const kinds = (b: ClientBreakdown, h: PortfolioHealth | null = health(65)) => opportunitiesFor(b, h).map((o) => o.kind);

describe('ready to fund growth', () => {
  it('Stable or Strong, with funding readiness and cash each at 70', () => {
    const b = breakdown(dim('funding_readiness', 70), dim('cash_flow', 70));
    expect(kinds(b, health(60))).toEqual(['ready_to_fund_growth']);
    expect(opportunitiesFor(b, health(60))[0]!.because).toEqual(['Health is Stable', 'Funding readiness scores 70', 'Cash scores 70']);
  });
  it('not at 69, not when Health needs attention, not when funding readiness is not scored', () => {
    expect(kinds(breakdown(dim('funding_readiness', 69), dim('cash_flow', 90)))).toEqual([]);
    expect(kinds(breakdown(dim('funding_readiness', 90), dim('cash_flow', 90)), health(59))).toEqual([]);
    expect(kinds(breakdown(dim('funding_readiness', null), dim('cash_flow', 90)))).toEqual([]);
  });
});

describe('surplus cash', () => {
  const cash = (result: string) => dim('cash_flow', 60, [['C2', result === '>= 6 months' ? 20 : 5, result, '7.5']]);
  it('cash lasts 6 months or more and profitability scores 60', () => {
    expect(kinds(breakdown(cash('>= 6 months'), dim('profitability', T.surplusCashProfitability)))).toEqual(['surplus_cash']);
  });
  it('not with 3 to 6 months, nor with profitability at 59', () => {
    expect(kinds(breakdown(cash('3 to 6 months'), dim('profitability', 90)))).toEqual([]);
    expect(kinds(breakdown(cash('>= 6 months'), dim('profitability', 59)))).toEqual([]);
  });
  it('a skipped runway rule is not "6 months"', () => {
    const skipped: BreakdownDimension = { key: 'cash_flow', included: true, score: 60,
      rules: [{ rule: 'C2', points: 0, result: 'skipped', value: null, skipped: 'runway_unavailable' }] };
    expect(kinds(breakdown(skipped, dim('profitability', 90)))).toEqual([]);
  });
});

describe('campaigns paying back', () => {
  it('marketing at 70, quoting the stored M1 band', () => {
    const b = breakdown(dim('marketing_efficiency', 70, [['M1', 20, '>= 3x', '3.4']]));
    expect(opportunitiesFor(b, health(65))).toEqual([expect.objectContaining({
      kind: 'campaigns_paying_back',
      because: ['Marketing scores 70', 'Customers won by campaigns brought in >= 3x what the campaigns cost'],
    })]);
  });
  it('not at 69, and not when marketing was not scored', () => {
    expect(kinds(breakdown(dim('marketing_efficiency', 69)))).toEqual([]);
    expect(kinds(breakdown(dim('marketing_efficiency', null)))).toEqual([]);
  });
});

describe('growing on thin margins', () => {
  it('sales growth at 65 with profitability at 49', () => {
    expect(kinds(breakdown(dim('revenue_growth', 65), dim('profitability', 49)))).toEqual(['growing_on_thin_margins']);
  });
  it('not at 64, nor with profitability at 50', () => {
    expect(kinds(breakdown(dim('revenue_growth', 64), dim('profitability', 20)))).toEqual([]);
    expect(kinds(breakdown(dim('revenue_growth', 90), dim('profitability', 50)))).toEqual([]);
  });
});

describe('collections and working capital', () => {
  it('customers taking over 60 days', () => {
    const b = breakdown(dim('customer_quality', 40, [['Q3', -10, '60 to 90 days', '61.4']]));
    expect(opportunitiesFor(b, health(65))[0]).toMatchObject({ kind: 'collections', because: ['Customers take about 61 days to pay'] });
    expect(kinds(breakdown(dim('customer_quality', 40, [['Q3', 0, '30 to 60 days', '60']])))).toEqual([]);
  });
  it('30% or more of what customers owe overdue', () => {
    const b = breakdown(dim('funding_readiness', 40, [['R3', -10, '30% to 50%', '0.3']]));
    expect(opportunitiesFor(b, health(65))[0]).toMatchObject({ kind: 'collections', because: ['30.0% of what customers owe is overdue'] });
    expect(kinds(breakdown(dim('funding_readiness', 40, [['R3', 10, 'below 30%', '0.299999']])))).toEqual([]);
  });
});

describe('momentum', () => {
  it('a rise of 10 points, or a move up a band', () => {
    expect(opportunitiesFor(breakdown(), health(75, 65))[0]).toMatchObject({ kind: 'momentum', because: ['Health score rose 10 points since Jul 2026'] });
    expect(opportunitiesFor(breakdown(), health(61, 58))[0]).toMatchObject({ because: ['Health rose from Needs attention to Stable since Jul 2026'] });
  });
  it('not 9 points within a band, and not without a comparable previous month', () => {
    expect(kinds(breakdown(), health(74, 65))).toEqual([]);
    expect(kinds(breakdown(), health(90))).toEqual([]);
  });
});

describe('the list', () => {
  it('is in a fixed order, and a client with none has no entry', () => {
    const b = breakdown(
      dim('funding_readiness', 80, [['R3', -20, '50% or more', '0.55']]), dim('cash_flow', 80, [['C2', 20, '>= 6 months', '9']]),
      dim('profitability', 70), dim('marketing_efficiency', 75),
    );
    expect(kinds(b, health(80, 70))).toEqual(['ready_to_fund_growth', 'surplus_cash', 'campaigns_paying_back', 'collections', 'momentum']);
    expect(opportunityEntry(breakdown(), health(65))).toBeNull();
    expect(opportunityEntry(b, health(80))).toMatchObject({ organizationId: 'o', healthScoreId: 'hs', evidenceBundleId: 'eb' });
  });
});
