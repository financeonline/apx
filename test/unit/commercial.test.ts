import { describe, expect, it } from 'vitest';
import {
  acquisitionCost, attributeCampaignRevenue, conversion, pipelineByStage, productContribution,
  salesByPeriod, wonCustomers, type OpportunityRow,
} from '@/modules/commercial';

/**
 * Commercial rules (Phase 14, ADR-102). What is asserted is the honesty of each rule: no cost without
 * a line, no revenue without a won opportunity, no CAC without both halves, no ratio over zero, and
 * the same answer in any input order.
 */
const P = (id: string, start: string, end: string) => ({ id, label: id, periodStart: start, periodEnd: end });
const JUL = P('jul', '2026-07-01', '2026-07-31');
const AUG = P('aug', '2026-08-01', '2026-08-31');
const SEP = P('sep', '2026-09-01', '2026-09-30');

const opp = (over: Partial<OpportunityRow> & Pick<OpportunityRow, 'id' | 'stage'>): OpportunityRow => ({
  name: over.id, counterpartyId: null, campaignId: null, channelId: null, estimatedValue: null,
  createdOn: '2026-07-10', stageChangedOn: '2026-07-10', wonOn: null, lostOn: null, ...over,
});

describe('product contribution', () => {
  it('is unavailable without cost lines, and is revenue minus cost with them', () => {
    expect(productContribution({ sales: '1000.00', cost: '0', salesLines: 3, costLines: 0 })).toEqual({
      revenue: '1000.00', cost: null, contribution: null, marginRatio: null, reason: 'no_cost_lines',
    });
    expect(productContribution({ sales: '1000.00', cost: '400.00', salesLines: 3, costLines: 1 })).toEqual({
      revenue: '1000.00', cost: '400.00', contribution: '600.00', marginRatio: '0.600000', reason: null,
    });
    expect(productContribution({ sales: '0', cost: '50.00', salesLines: 0, costLines: 1 }).reason).toBe('no_sales_lines');
  });
});

describe('campaign attribution', () => {
  const insta = 'camp-insta'; const google = 'camp-google';
  const rows = [
    opp({ id: 'o1', stage: 'won', counterpartyId: 'acme', campaignId: insta, wonOn: '2026-08-05' }),
    opp({ id: 'o2', stage: 'won', counterpartyId: 'acme', campaignId: google, wonOn: '2026-09-01' }), // later win, same customer
    opp({ id: 'o3', stage: 'won', counterpartyId: 'beta', campaignId: google, wonOn: '2026-09-03' }),
    opp({ id: 'o4', stage: 'proposal', counterpartyId: 'gamma', campaignId: insta }),
    opp({ id: 'o5', stage: 'won', counterpartyId: null, campaignId: insta, wonOn: '2026-08-20' }), // won without a customer: nothing to attribute
  ];
  const revenue = new Map([
    ['jul', new Map([['acme', '900.00'], ['beta', '100.00']])],
    ['aug', new Map([['acme', '1000.00'], ['beta', '200.00']])],
    ['sep', new Map([['acme', '1100.00'], ['beta', '300.00'], ['gamma', '5000.00']])],
  ]);

  it('credits revenue only from the won month, to the earliest winning campaign, never to an open opportunity', () => {
    const [g, i] = attributeCampaignRevenue({ campaignIds: [insta, google], opportunities: rows, periods: [JUL, AUG, SEP], customerRevenue: revenue });
    expect(i!.status).toBe('attributed_via_won_opportunities');
    expect(i!.customers.map((c) => c.counterpartyId)).toEqual(['acme']);
    expect([...i!.revenueByPeriod.entries()]).toEqual([['jul', '0.00'], ['aug', '1000.00'], ['sep', '1100.00']]);
    expect(i!.revenue).toBe('2100.00');
    // Google gets beta from September only; acme belongs to the earlier Instagram win.
    expect(g!.customers.map((c) => c.counterpartyId)).toEqual(['beta']);
    expect(g!.revenue).toBe('300.00');
    // gamma (proposal) is nobody's.
    expect(JSON.stringify([g, i])).not.toContain('gamma');
  });

  it('says so when a campaign has no won opportunity', () => {
    const [none] = attributeCampaignRevenue({ campaignIds: ['camp-empty'], opportunities: rows, periods: [AUG], customerRevenue: revenue });
    expect(none).toMatchObject({ status: 'no_won_opportunities', revenue: '0.00', customers: [] });
  });

  it('is independent of input order', () => {
    const a = attributeCampaignRevenue({ campaignIds: [google, insta], opportunities: rows, periods: [SEP, JUL, AUG], customerRevenue: revenue });
    const b = attributeCampaignRevenue({ campaignIds: [insta, google], opportunities: [...rows].reverse(), periods: [JUL, AUG, SEP], customerRevenue: revenue });
    expect(a.map((x) => [x.campaignId, x.revenue, [...x.revenueByPeriod]])).toEqual(b.map((x) => [x.campaignId, x.revenue, [...x.revenueByPeriod]]));
    expect(wonCustomers(rows)).toEqual(wonCustomers([...rows].reverse()));
  });
});

describe('acquisition cost', () => {
  const rows = [
    opp({ id: 'o1', stage: 'won', counterpartyId: 'acme', campaignId: 'c', wonOn: '2026-08-05' }),
    opp({ id: 'o2', stage: 'won', counterpartyId: 'beta', campaignId: 'c', wonOn: '2026-08-20' }),
    opp({ id: 'o3', stage: 'won', counterpartyId: 'old', campaignId: 'c', wonOn: '2026-06-01' }), // outside the window
  ];
  const window = { periodIds: ['aug'], from: '2026-08-01', to: '2026-08-31' };

  it('divides recorded spend by customers won through the campaign in the same window', () => {
    const [c] = acquisitionCost({ campaignIds: ['c'], spend: [{ campaignId: 'c', periodId: 'aug', amount: '500.00' }, { campaignId: 'c', periodId: 'jul', amount: '999.00' }], opportunities: rows, window });
    expect(c).toEqual({ campaignId: 'c', spend: '500.00', customersWon: 2, cac: '250.00', reason: null });
  });

  it('never divides by zero, and never uses customers the campaign did not win', () => {
    const [noSpend] = acquisitionCost({ campaignIds: ['c'], spend: [], opportunities: rows, window });
    expect(noSpend).toMatchObject({ cac: null, reason: 'no_spend_recorded', customersWon: 2 });
    const [noWins] = acquisitionCost({ campaignIds: ['d'], spend: [{ campaignId: 'd', periodId: 'aug', amount: '300.00' }], opportunities: rows, window });
    expect(noWins).toMatchObject({ spend: '300.00', customersWon: 0, cac: null, reason: 'no_customers_won' });
  });
});

describe('conversion and the pipeline', () => {
  const rows = [
    opp({ id: 'l1', stage: 'lead', createdOn: '2026-08-02' }),
    opp({ id: 'l2', stage: 'qualified', createdOn: '2026-08-03' }),
    opp({ id: 'l3', stage: 'won', createdOn: '2026-08-04', counterpartyId: 'acme', wonOn: '2026-08-30', estimatedValue: '1200.00' }),
    opp({ id: 'l4', stage: 'lost', createdOn: '2026-08-05', lostOn: '2026-08-12' }),
    opp({ id: 'l5', stage: 'won', createdOn: '2026-06-01', counterpartyId: 'beta', wonOn: '2026-08-10', estimatedValue: '800.00' }), // older lead, won this month
    opp({ id: 'l6', stage: 'proposal', createdOn: '2026-07-20', estimatedValue: '5000.00' }),
  ];

  it('names its cohort and denominators', () => {
    const c = conversion(rows, { from: '2026-08-01', to: '2026-08-31' });
    expect(c).toMatchObject({ leadsCreated: 4, progressed: 2, wonFromCohort: 1, lostFromCohort: 1, wonInWindow: 2, reasons: [] });
    expect(c.leadToOpportunity).toBe('0.500000');
    expect(c.opportunityToCustomer).toBe('0.500000');
  });

  it('yields null with a reason on an empty window, not a division', () => {
    const none = conversion(rows, { from: '2025-01-01', to: '2025-01-31' });
    expect(none).toMatchObject({ leadsCreated: 0, leadToOpportunity: null, opportunityToCustomer: null, reasons: ['no_leads_in_window'] });
    const onlyLeads = conversion([opp({ id: 'x', stage: 'lead', createdOn: '2026-08-09' })], { from: '2026-08-01', to: '2026-08-31' });
    expect(onlyLeads).toMatchObject({ leadsCreated: 1, progressed: 0, leadToOpportunity: '0.000000', opportunityToCustomer: null, reasons: ['no_opportunities_in_window'] });
  });

  it('sums stated values only, and counts the unvalued', () => {
    const stages = pipelineByStage(rows);
    expect(stages.find((s) => s.stage === 'proposal')).toEqual({ stage: 'proposal', count: 1, value: '5000.00', valued: 1 });
    expect(stages.find((s) => s.stage === 'lead')).toEqual({ stage: 'lead', count: 1, value: '0.00', valued: 0 });
    const aug = salesByPeriod(rows, [JUL, AUG]).find((p) => p.periodId === 'aug')!;
    expect(aug).toEqual({ periodId: 'aug', label: 'aug', created: 4, won: 2, wonValue: '2000.00', lost: 1 });
  });
});
