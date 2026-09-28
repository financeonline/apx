import { describe, expect, it } from 'vitest';
import {
  buildDigest, groundBriefing,
  type Briefing, type ClientCounts, type ClientRow, type Digest, type Fact, type PortfolioAlert,
  type PortfolioOrganisation, type PortfolioView,
} from '@/modules/portfolio';

/**
 * Phase 15 adviser-analyst evaluation (brief §20; ADR-113, ADR-114 §5).
 *
 * The cases hold the contract the server enforces AROUND the model. What the model is handed is
 * decided by construction (the digest is built from the authorised view and nothing else); what it
 * may say is decided by fact-specific grounding, which is deterministic. The live-model behaviour
 * behind both boundaries is exercised in `test/integration/portfolio-ai.test.ts` with a recording fake.
 */

const org = (id: string, name: string): PortfolioOrganisation => ({ id, slug: id, name, status: 'active', role: 'employee' });
const zero: ClientCounts = { alertsStanding: 0, alertsCritical: 0, alertsHigh: 0, actionsOpen: 0, actionsOverdue: 0, actionsDueSoon: 0, actionsUrgent: 0, actionsUrgentOnTime: 0, actionsMine: 0 };

const alpha: ClientRow = {
  organisation: org('a', 'Alpha Ltd'),
  health: { organizationId: 'a', scoreId: 's', periodId: 'p', periodStart: '2026-08-01', periodLabel: 'Aug 2026', score: 38, band: 'at_risk', dimensionsUsed: 5, dimensionsTotal: 6, previous: { periodStart: '2026-07-01', periodLabel: 'Jul 2026', score: 61, band: 'stable' } },
  trend: 'down',
  counts: { ...zero, alertsStanding: 1, alertsCritical: 1 },
  attention: { organizationId: 'a', rank: [100, 250], reasons: [
    { kind: 'critical_alert', weight: 100, label: '1 critical alert', count: 1 },
    { kind: 'health_band_fell', weight: 80, label: 'Health fell from Stable to At risk', count: 1 },
    { kind: 'health_at_risk', weight: 70, label: 'Health is At risk', count: 1 },
  ] },
  latestChange: null,
};
const beta: ClientRow = { organisation: org('b', 'Beta Ltd'), health: null, trend: null, counts: zero, attention: null, latestChange: null };
const alphaAlert: PortfolioAlert = { id: 'al-1', organizationId: 'a', ruleKey: 'cash.runway_low', severity: 'critical', status: 'open', title: 'Cash runway under two months', periodId: 'p', firstSeenAt: '2026-09-10T00:00:00Z', lastEvaluatedAt: '2026-09-14T00:00:00Z', evidenceBundleId: null, actionId: null };

const view: PortfolioView = {
  today: '2026-09-15',
  organisations: [alpha.organisation, beta.organisation],
  clients: [alpha, beta],
  attention: [alpha],
  counts: { clients: 2, needingAttention: 1, healthy: 0, unscored: 1, alertsStanding: 1, criticalAlerts: 1, highAlerts: 0, openActions: 0, overdueActions: 0, dueSoonActions: 0, urgentActions: 0, myActions: 0 },
  recent: [],
};
const digest = buildDigest(view, [alphaAlert], []);

const answer = (partial: Partial<Briefing>): Briefing => ({
  mode: 'answer', headline: { text: 'Alpha needs attention.', facts: [] }, clients: [], notes: [], limitations: [], ...partial,
});

describe('Phase 15 adviser eval — scope and citations', () => {
  it('1. an employee with two assigned clients: the digest holds exactly those two, with facts for each', () => {
    expect(digest.clients.map((c) => c.name)).toEqual(['Alpha Ltd', 'Beta Ltd']);
    expect(digest.facts.find((f) => f.id === 'client:1/health_score')).toMatchObject({ value: '38', unit: 'score', period: 'Aug 2026' });
    expect(digest.facts.some((f) => f.subject === 'client:2' && f.metric === 'health_score')).toBe(false);
  });

  it('2. the employee asks about an unassigned client: the model cannot introduce one', () => {
    const g = groundBriefing(answer({ clients: [{ ref: 'client:3', summary: 'Gamma has a critical alert.', facts: [], because: ['alert:9'] }] }), digest);
    expect(g.briefing.clients).toEqual([]);
    expect(g.status).toBe('degraded');
    expect(g.removed).toContain('client client:3: not in the portfolio');
  });

  it('3. a foreign citation cannot survive', () => {
    const g = groundBriefing(answer({ clients: [{ ref: 'client:2', summary: 'Beta.', facts: [], because: ['alert:1'] }] }), digest);
    expect(g.briefing.clients[0]!.because).toEqual([]);
    expect(g.status).toBe('degraded');
  });

  it('4. which clients need attention: a faithful answer, citing its facts, passes', () => {
    const g = groundBriefing(answer({
      headline: { text: '1 of 2 clients needs attention.', facts: ['portfolio/needing_attention', 'portfolio/clients'] },
      clients: [{ ref: 'client:1', summary: 'Alpha Ltd has 1 critical alert. Its health score fell from 61 in Jul 2026 to 38 in Aug 2026.', facts: ['client:1/critical_alerts', 'client:1/previous_health_score', 'client:1/health_score'], because: ['alert:1'] }],
    }), digest);
    expect(g.removed).toEqual([]);
    expect(g.status).toBe('passed');
  });

  it('5. a health change may state the scores the data holds; a derived percentage may not', () => {
    const invented = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'Health fell 38%. It has 1 critical alert.', facts: ['client:1/health_score', 'client:1/critical_alerts'], because: [] }] }), digest);
    expect(invented.status).toBe('degraded');
    expect(invented.briefing.clients[0]!.summary).toBe('It has 1 critical alert.');
  });

  it('6. quoting a cited alert title verbatim, in quotation marks, carries the title\'s own words', () => {
    const g = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'The alert “Cash runway under two months” stands.', facts: [], because: ['alert:1'] }] }), digest);
    expect(g.removed).toEqual([]);
    expect(g.status).toBe('passed');
  });

  it('6b. the same title unquoted is prose, and its "two months" is a claim no fact states (ADR-115)', () => {
    const g = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'Cash runway under two months is the alert that stands.', facts: [], because: ['alert:1'] }] }), digest);
    expect(g.status).toBe('degraded');
  });

  it('7. an unsupported financial figure is removed, and the headline falls back to the server\'s', () => {
    const g = groundBriefing(answer({ headline: { text: 'Portfolio revenue is £412,000 this month.', facts: [] }, notes: [{ text: 'Cash is £58,000.', facts: [] }] }), digest);
    expect(g.status).toBe('degraded');
    expect(g.briefing.headline.text).toBe('1 of 2 clients need attention.');
    expect(g.briefing.notes).toEqual([]);
  });

  it('8. an unavailable metric stays unavailable: no score fact exists for Beta, so no score survives', () => {
    const g = groundBriefing(answer({ clients: [{ ref: 'client:2', summary: 'Beta Ltd has a health score of 0.', facts: ['client:2/standing_alerts'], because: [] }] }), digest);
    expect(g.status).toBe('degraded');
    expect(g.briefing.clients[0]!.summary).toBe('Beta Ltd: nothing needs attention.');
  });
});

/**
 * MEDIUM-D (audit of bab3a68): "a number that appears somewhere in the digest" was accepted as
 * grounding — "Revenue fell 1%" passed because some count was 1. These digests carry financial facts
 * so that the rule is tested on the claims it exists for.
 */
const f = (subject: string, metric: string, words: string[], value: string, unit: Fact['unit'], period: string | null): Fact =>
  ({ id: `${subject}/${metric}`, subject, metric, words, value, unit, period });

const financial: Digest = {
  today: '2026-09-15',
  clients: [
    { ref: 'client:1', id: 'a', name: 'Alpha Ltd', status: 'active', health: null, attention: [], alerts: [], actions: [] },
    { ref: 'client:2', id: 'b', name: 'Beta Ltd', status: 'active', health: null, attention: [], alerts: [], actions: [] },
  ],
  facts: [
    f('client:1', 'revenue_change', ['revenue'], '8', 'percent', 'Aug 2026'),
    f('client:1', 'cash_runway', ['runway'], '3', 'months', 'Aug 2026'),
    f('client:1', 'net_margin', ['margin'], '14', 'percent', 'Aug 2026'),
    f('client:1', 'open_actions', ['action'], '1', 'count', null),
    f('client:2', 'critical_alerts', ['critical'], '1', 'count', null),
    f('portfolio', 'clients', ['client'], '2', 'count', null),
    f('portfolio', 'needing_attention', ['attention', 'need'], '1', 'count', null),
  ],
};

describe('MEDIUM-D — grounding is fact-specific, not number-presence', () => {
  const cites = ['client:1/revenue_change', 'client:1/cash_runway', 'client:1/net_margin', 'client:1/open_actions'];

  it('the audit\'s case: revenue, runway and margin claims of "1" are all removed', () => {
    const g = groundBriefing(answer({
      clients: [{ ref: 'client:1', summary: 'Revenue fell 1%. Cash runway is 1 month. Profit margin is 1%.', facts: cites, because: [] }],
    }), financial);
    expect(g.status).toBe('degraded');
    expect(g.briefing.clients[0]!.summary).toBe('Alpha Ltd: nothing needs attention.');
  });

  it('wrong revenue and wrong runway are removed; the correct margin survives', () => {
    const g = groundBriefing(answer({
      clients: [{ ref: 'client:1', summary: 'Revenue declined 3%. Cash runway is 8 months. Profit margin is 14%.', facts: cites, because: [] }],
    }), financial);
    expect(g.status).toBe('degraded');
    expect(g.briefing.clients[0]!.summary).toBe('Profit margin is 14%.');
    expect(g.removed.filter((r) => r.startsWith('client:1 summary'))).toHaveLength(2);
  });

  it('correct figures with their units, metrics and period all survive', () => {
    const g = groundBriefing(answer({
      clients: [{ ref: 'client:1', summary: 'Revenue fell 8% in Aug 2026. Cash runway is 3 months. Net margin is 14%.', facts: cites, because: [] }],
    }), financial);
    expect(g.removed).toEqual([]);
    expect(g.status).toBe('passed');
  });

  it('the same number in another organisation does not ground a claim about this one', () => {
    // Alpha cites Beta's "1 critical alert" to support "1 critical alert" about Alpha.
    const g = groundBriefing(answer({
      clients: [{ ref: 'client:1', summary: 'Alpha Ltd has 1 critical alert.', facts: ['client:2/critical_alerts'], because: [] }],
    }), financial);
    expect(g.status).toBe('degraded');
    expect(g.removed).toEqual(expect.arrayContaining(['client:1: cites client:2/critical_alerts, a fact about client:2']));
    expect(g.briefing.clients[0]!.summary).not.toContain('1 critical');
  });

  it('a number with the right value but the wrong metric word is removed', () => {
    // Alpha's open-action count is 1; that does not make "margin is 1" true.
    const g = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'Margin is 1.', facts: ['client:1/open_actions'], because: [] }] }), financial);
    expect(g.status).toBe('degraded');
  });

  it('a figure stated for a different period is removed', () => {
    const g = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'Revenue fell 8% in Jul 2026.', facts: ['client:1/revenue_change'], because: [] }] }), {
      ...financial,
      // Jul 2026 is a period the digest knows (another fact carries it), so naming it is a claim about it.
      facts: [...financial.facts, f('client:1', 'previous_health_score', ['health'], '61', 'score', 'Jul 2026')],
    });
    expect(g.status).toBe('degraded');
  });

  it('an uncited fact grounds nothing, even with the right value, unit and word', () => {
    const g = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'Revenue fell 8%.', facts: [], because: [] }] }), financial);
    expect(g.status).toBe('degraded');
  });

  it('a limitation may not state a number', () => {
    const g = groundBriefing(answer({ limitations: ['Revenue is down 40% but we cannot see why.'] }), financial);
    expect(g.briefing.limitations).toEqual([]);
    expect(g.status).toBe('degraded');
  });
});

/**
 * M-1 and L-2 (independent audit of 71fd748; ADR-115). Grounding binds every quantitative CLAIM —
 * in digits, in words, as a fraction or a multiplier — to one cited fact of the same value, unit,
 * metric, subject, period and direction. These digests carry financial facts the Phase 15 digest
 * does not, so that each rule is tested on the claims it exists for: with the fact, the claim
 * survives; without it, a coincidental number elsewhere never grounds it.
 */
const withFacts = (facts: Fact[], clients: Digest['clients'] = financial.clients): Digest => ({ today: '2026-09-15', clients, facts });
const summaryOf = (d: Digest, text: string, facts: string[], because: string[] = []) =>
  groundBriefing(answer({ clients: [{ ref: 'client:1', summary: text, facts, because }] }), d);
const noteOf = (d: Digest, text: string, facts: string[]) => groundBriefing(answer({ notes: [{ text, facts }] }), d);
const fx = (fact: Fact, extra: Partial<Fact>): Fact => ({ ...fact, ...extra });

const REVENUE_20 = fx(f('client:1', 'revenue_change', ['revenue'], '20', 'percent', 'Sep 2026'), { direction: 'decrease' });
const RUNWAY_1_5 = f('client:1', 'cash_runway', ['runway'], '1.5', 'months', 'Sep 2026');
const COSTS_X2 = fx(f('client:1', 'cost_multiple', ['cost'], '2', 'multiple', 'Sep 2026'), { direction: 'increase' });
const MARGIN_HALF = fx(f('client:1', 'margin_multiple', ['margin'], '0.5', 'multiple', 'Sep 2026'), { direction: 'decrease' });
const COUNT_OF = (metric: string, value: string, words: string[], extra: Partial<Fact> = {}) => fx(f('client:1', metric, words, value, 'count', null), extra);

describe('M-1 — a figure in words is a claim, bound to a fact or removed (brief §6)', () => {
  it('A. "Revenue fell by twenty per cent" survives only with a 20% revenue-decline fact', () => {
    expect(summaryOf(withFacts([REVENUE_20]), 'Revenue fell by twenty per cent.', [REVENUE_20.id]).status).toBe('passed');
    const other = COUNT_OF('open_actions', '20', ['action']);
    expect(summaryOf(withFacts([other]), 'Revenue fell by twenty per cent.', [other.id]).status).toBe('degraded');
  });

  it('B. "Runway is one and a half months" survives only with a 1.5-month runway fact', () => {
    expect(summaryOf(withFacts([RUNWAY_1_5]), 'Runway is one and a half months.', [RUNWAY_1_5.id]).status).toBe('passed');
    const twoMonths = f('client:1', 'cash_runway', ['runway'], '2', 'months', 'Sep 2026');
    expect(summaryOf(withFacts([twoMonths]), 'Runway is one and a half months.', [twoMonths.id]).status).toBe('degraded');
  });

  it('C. "Costs doubled" needs a fact that states a doubling; a raw 2 elsewhere is not one', () => {
    expect(summaryOf(withFacts([COSTS_X2]), 'Costs doubled.', [COSTS_X2.id]).status).toBe('passed');
    const two = COUNT_OF('open_actions', '2', ['action', 'cost']);
    const g = summaryOf(withFacts([two]), 'Costs doubled.', [two.id]);
    expect(g.status).toBe('degraded');
    expect(g.briefing.clients[0]!.summary).not.toContain('doubled');
  });

  it('D. "Revenue declined twenty-five percent": a 25% fact grounds it, a 20% fact does not', () => {
    const r25 = fx(REVENUE_20, { value: '25' });
    expect(summaryOf(withFacts([r25]), 'Revenue declined twenty-five percent.', [r25.id]).status).toBe('passed');
    expect(summaryOf(withFacts([REVENUE_20]), 'Revenue declined twenty-five percent.', [REVENUE_20.id]).status).toBe('degraded');
  });

  it('E. "Runway is one month": a 1-month runway grounds it; an unrelated count of 1 does not', () => {
    const r1 = f('client:1', 'cash_runway', ['runway'], '1', 'months', 'Sep 2026');
    expect(summaryOf(withFacts([r1]), 'Runway is one month.', [r1.id]).status).toBe('passed');
    const count1 = COUNT_OF('open_actions', '1', ['action']);
    expect(summaryOf(withFacts([count1]), 'Runway is one month.', [count1.id]).status).toBe('degraded');
  });

  it('F. "Revenue fell by one percent" is not grounded by open actions = 1 or another metric = 1', () => {
    const actions1 = COUNT_OF('open_actions', '1', ['action']);
    const margin1 = f('client:1', 'net_margin', ['margin'], '1', 'percent', 'Sep 2026');
    const g = summaryOf(withFacts([actions1, margin1]), 'Revenue fell by one percent.', [actions1.id, margin1.id]);
    expect(g.status).toBe('degraded');
  });
});

describe('brief §8 — multiplier language', () => {
  it('"halved" needs a 0.5 multiple of that metric', () => {
    expect(summaryOf(withFacts([MARGIN_HALF]), 'Margin halved.', [MARGIN_HALF.id]).status).toBe('passed');
    expect(summaryOf(withFacts([MARGIN_HALF]), 'Costs halved.', [MARGIN_HALF.id]).status).toBe('degraded');
    expect(summaryOf(withFacts([COSTS_X2]), 'Costs halved.', [COSTS_X2.id]).status).toBe('degraded');
  });

  it('"Costs doubled from 10,000 to 20,000" needs the doubling AND both values', () => {
    const before = f('client:1', 'costs_before', ['cost'], '10000', 'money', 'Aug 2026');
    const after = f('client:1', 'costs_after', ['cost'], '20000', 'money', 'Sep 2026');
    const all = [COSTS_X2, before, after];
    expect(summaryOf(withFacts(all), 'Costs doubled from £10,000 to £20,000.', all.map((x) => x.id)).status).toBe('passed');
    expect(summaryOf(withFacts([COSTS_X2]), 'Costs doubled from £10,000 to £20,000.', [COSTS_X2.id]).status).toBe('degraded');
  });

  it('twice as high, three times as high, twofold — only with the multiple', () => {
    for (const s of ['Costs are twice as high.', 'Costs increased twofold.', 'Costs are 2x last month.']) {
      expect(summaryOf(withFacts([COSTS_X2]), s, [COSTS_X2.id]).status, s).toBe('passed');
    }
    expect(summaryOf(withFacts([COSTS_X2]), 'Costs are three times as high.', [COSTS_X2.id]).status).toBe('degraded');
  });

  it('a stated direction must agree with the fact\'s', () => {
    expect(summaryOf(withFacts([REVENUE_20]), 'Revenue rose 20%.', [REVENUE_20.id]).status).toBe('degraded');
    expect(summaryOf(withFacts([REVENUE_20]), 'Revenue fell 20%.', [REVENUE_20.id]).status).toBe('passed');
  });
});

describe('brief §9 — each claim in a sentence is validated on its own', () => {
  const REVENUE_8 = fx(REVENUE_20, { value: '8' });
  const RUNWAY_3 = f('client:1', 'cash_runway', ['runway'], '3', 'months', 'Sep 2026');

  it('two claims, both true: the sentence stands', () => {
    const g = summaryOf(withFacts([REVENUE_8, RUNWAY_3]), 'Revenue fell 8% while runway is 3 months.', [REVENUE_8.id, RUNWAY_3.id]);
    expect(g.removed).toEqual([]);
    expect(g.status).toBe('passed');
  });

  it('one true claim cannot rescue a false one; the other sentences stand', () => {
    const g = summaryOf(withFacts([REVENUE_8, RUNWAY_3]), 'Revenue fell 8% while runway is 5 months. Runway is 3 months.', [REVENUE_8.id, RUNWAY_3.id]);
    expect(g.status).toBe('degraded');
    expect(g.briefing.clients[0]!.summary).toBe('Runway is 3 months.');
  });

  it('a claim cannot borrow the metric of another clause (audit L-3)', () => {
    const actions8 = COUNT_OF('open_actions', '8', ['action']);
    expect(summaryOf(withFacts([actions8]), 'Runway is 8, per the open action list.', [actions8.id]).status).toBe('degraded');
    expect(summaryOf(withFacts([actions8]), 'Runway is 8 open actions.', [actions8.id]).status).toBe('degraded');
  });

  it('swapped counts in one sentence are both caught', () => {
    const critical1 = COUNT_OF('critical_alerts', '1', ['critical'], { noun: 'alert' });
    const overdue2 = COUNT_OF('overdue_actions', '2', ['overdue'], { noun: 'action' });
    const ids = [critical1.id, overdue2.id];
    expect(summaryOf(withFacts([critical1, overdue2]), 'Alpha Ltd has 1 critical alert and 2 overdue actions.', ids).status).toBe('passed');
    expect(summaryOf(withFacts([critical1, overdue2]), 'Alpha Ltd has 2 critical alerts and 1 overdue action.', ids).status).toBe('degraded');
  });

  it('a generic count does not state a specific one: 3 open actions are not 3 overdue actions', () => {
    const open3 = COUNT_OF('open_actions', '3', ['action'], { excludes: ['overdue', 'urgent', 'due'] });
    expect(summaryOf(withFacts([open3]), 'Alpha Ltd has 3 overdue actions.', [open3.id]).status).toBe('degraded');
  });
});

describe('brief §11 — wrong metric, period or organisation with a matching number', () => {
  const A_REV_8 = fx(f('client:1', 'revenue_change', ['revenue'], '8', 'percent', 'Sep 2026'), { direction: 'decrease' });
  const A_RUNWAY_3 = f('client:1', 'cash_runway', ['runway'], '3', 'months', 'Sep 2026');
  const B_REV_2 = fx(f('client:2', 'revenue_change', ['revenue'], '2', 'percent', 'Sep 2026'), { direction: 'decrease' });
  const d = withFacts([A_REV_8, A_RUNWAY_3, B_REV_2]);
  const all = [A_REV_8.id, A_RUNWAY_3.id, B_REV_2.id];

  it('the true statements pass, in a summary and in a note', () => {
    expect(summaryOf(d, 'Alpha Ltd revenue declined 8% in September.', [A_REV_8.id]).status).toBe('passed');
    expect(noteOf(d, 'Beta Ltd revenue declined 2% in Sep 2026.', all).status).toBe('passed');
  });

  it('"Alpha revenue declined 2%" fails: 2% is Beta\'s', () => {
    expect(summaryOf(d, 'Alpha Ltd revenue declined 2%.', all).status).toBe('degraded');
    expect(noteOf(d, 'Alpha Ltd revenue declined 2%.', all).status).toBe('degraded');
  });

  it('"Alpha revenue declined 8% in August" fails: the fact is for September', () => {
    expect(summaryOf(d, 'Alpha Ltd revenue declined 8% in August.', [A_REV_8.id]).status).toBe('degraded');
    expect(summaryOf(d, 'Alpha Ltd revenue declined 8% in Aug 2026.', [A_REV_8.id]).status).toBe('degraded');
  });

  it('"Beta revenue declined 8%" fails: 8% is Alpha\'s', () => {
    expect(noteOf(d, 'Beta Ltd revenue declined 8%.', all).status).toBe('degraded');
    // In Beta's own summary Alpha's fact cannot even be cited.
    const g = groundBriefing(answer({ clients: [{ ref: 'client:2', summary: 'Beta Ltd revenue declined 8%.', facts: all, because: [] }] }), d);
    expect(g.status).toBe('degraded');
  });

  it('runway 3 months does not make revenue 3%', () => {
    expect(summaryOf(d, 'Alpha Ltd revenue declined 3%.', all).status).toBe('degraded');
  });

  it('a note about a client that names no client is not grounded by that client\'s fact', () => {
    expect(noteOf(d, 'Revenue declined 8%.', all).status).toBe('degraded');
  });
});

describe('brief §12 — hedged and unquantified language is never coerced into an exact claim', () => {
  it.each([
    'Revenue fell significantly.', 'Revenue fell materially.', 'Costs roughly doubled.', 'About half of revenue was lost.',
    'Runway is nearly one and a half months.', 'Revenue fell more than twenty percent.', 'Revenue fell by about 20%.', 'Revenue fell by a third.',
    'Costs are three times higher.',
  ])('"%s" is removed even beside the exact fact', (sentence) => {
    const g = summaryOf(withFacts([REVENUE_20, RUNWAY_1_5, COSTS_X2]), sentence, [REVENUE_20.id, RUNWAY_1_5.id, COSTS_X2.id]);
    expect(g.status).toBe('degraded');
  });
});

describe('L-2 — alert and action titles are text, not facts', () => {
  const alertRow: PortfolioAlert = { ...alphaAlert, id: 'al-8', title: 'Revenue issue 8' };
  const actionRow = {
    id: 'ac-12', organizationId: 'a', title: 'Chase 12 overdue invoices', priority: 'high', status: 'open', ownerUserId: null,
    dueDate: null, sourceType: 'manual', evidenceBundleId: null, createdAt: '2026-09-01T00:00:00Z', completedAt: null, updatedAt: '2026-09-01T00:00:00Z',
  } as const;
  const titled = buildDigest({ ...view, clients: [{ ...alpha, counts: { ...alpha.counts, actionsOpen: 1, actionsOverdue: 3 } }, beta] }, [alertRow], [actionRow]);

  it('an alert titled with 8 does not ground "Revenue fell 8%"', () => {
    const g = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'Revenue fell 8%.', facts: [], because: ['alert:1'] }] }), titled);
    expect(g.status).toBe('degraded');
  });

  it('an action titled with 12 does not ground "12 overdue actions"', () => {
    const g = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'Alpha Ltd has 12 overdue actions.', facts: ['client:1/overdue_actions'], because: ['action:1'] }] }), titled);
    expect(g.status).toBe('degraded');
  });

  it('the real count still grounds, with the title quoted beside it', () => {
    const g = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'Alpha Ltd has 3 overdue actions, including “Chase 12 overdue invoices”.', facts: ['client:1/overdue_actions'], because: ['action:1'] }] }), titled);
    expect(g.removed).toEqual([]);
    expect(g.status).toBe('passed');
  });

  it('a title used as a figure is refused (the old grounder erased "3" from "3%")', () => {
    const three = buildDigest(view, [{ ...alphaAlert, title: '3' }], []);
    for (const s of ['Revenue fell 3% this quarter.', 'Revenue fell “3”% this quarter.']) {
      const g = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: s, facts: [], because: ['alert:1'] }] }), three);
      expect(g.status, s).toBe('degraded');
    }
  });

  it('a title the summary does not cite is not quotable', () => {
    const g = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'The action “Chase 12 overdue invoices” stands.', facts: [], because: [] }] }), titled);
    expect(g.status).toBe('degraded');
  });
});

describe('brief §14 — the adviser eval set', () => {
  const base = [REVENUE_20, RUNWAY_1_5, COSTS_X2, MARGIN_HALF];
  const ids = base.map((x) => x.id);
  const cases: Array<[string, Digest, string, string[], 'passed' | 'degraded']> = [
    ['1 twenty percent, fact present', withFacts(base), 'Revenue fell twenty percent.', ids, 'passed'],
    ['1 twenty percent, no fact', withFacts([COUNT_OF('open_actions', '20', ['action'])]), 'Revenue fell twenty percent.', ['client:1/open_actions'], 'degraded'],
    ['2 one and a half months, fact present', withFacts(base), 'Runway is one and a half months.', ids, 'passed'],
    ['2 one and a half months, no fact', withFacts([COUNT_OF('open_actions', '1.5', ['action'])]), 'Runway is one and a half months.', ['client:1/open_actions'], 'degraded'],
    ['3 doubled, fact present', withFacts(base), 'Costs doubled.', ids, 'passed'],
    ['3 doubled, only a count of 2', withFacts([COUNT_OF('open_actions', '2', ['action'])]), 'Costs doubled.', ['client:1/open_actions'], 'degraded'],
    ['4 halved, fact present', withFacts(base), 'Margin halved.', ids, 'passed'],
    ['4 halved, no fact', withFacts([REVENUE_20]), 'Margin halved.', [REVENUE_20.id], 'degraded'],
    ['7 wrong metric, matching value', withFacts(base), 'Margin fell 20%.', ids, 'degraded'],
    ['8 wrong period, matching value', withFacts(base), 'Revenue fell 20% in Jul 2026.', ids, 'degraded'],
    ['10 two claims, both supported', withFacts(base), 'Revenue fell 20% and runway is 1.5 months.', ids, 'passed'],
    ['11 one supported, one not', withFacts(base), 'Revenue fell 20% and runway is 2 months.', ids, 'degraded'],
    ['12 uncited quantitative claim', withFacts(base), 'Revenue fell 20%.', [], 'degraded'],
  ];
  it.each(cases)('%s', (_name, d, text, facts, expected) => {
    expect(summaryOf(d, text, facts).status).toBe(expected);
  });

  it('9 wrong organisation, matching value', () => {
    const betaRevenue = fx(REVENUE_20, { id: 'client:2/revenue_change', subject: 'client:2' });
    expect(noteOf(withFacts([REVENUE_20, betaRevenue]), 'Beta Ltd revenue fell 20%.', [REVENUE_20.id]).status).toBe('degraded');
    expect(noteOf(withFacts([REVENUE_20, betaRevenue]), 'Beta Ltd revenue fell 20%.', [betaRevenue.id]).status).toBe('passed');
  });
  // Cases 5 and 6 (alert title 8, action title 12) are the L-2 block above.
});

describe('honest answers still pass (a check that fails correct answers gets switched off)', () => {
  it('the Command Centre\'s own statements', () => {
    const g = groundBriefing(answer({
      headline: { text: '1 of 2 clients needs attention across the portfolio.', facts: ['portfolio/needing_attention', 'portfolio/clients'] },
      clients: [{
        ref: 'client:1',
        summary: 'Alpha Ltd has 1 critical alert. Its health score fell 23 points, from 61 in Jul 2026 to 38 in Aug 2026. The alert “Cash runway under two months” stands.',
        facts: ['client:1/critical_alerts', 'client:1/health_score_change', 'client:1/previous_health_score', 'client:1/health_score'],
        because: ['alert:1'],
      }],
      notes: [{ text: 'Beta Ltd has no critical alerts.', facts: ['client:2/critical_alerts'] }],
      limitations: ['Financial figures are not in the data.'],
    }), buildDigest({ ...view, clients: [alpha, { ...beta, counts: zero }] }, [alphaAlert], []));
    expect(g.removed).toEqual([]);
    expect(g.status).toBe('passed');
  });

  it('a health change stated the wrong way round is removed', () => {
    const g = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'Its health score rose 23 points.', facts: ['client:1/health_score_change'], because: [] }] }), digest);
    expect(g.status).toBe('degraded');
  });

  it('"one of" and "no one" are English, not figures', () => {
    const g = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'Alpha Ltd is one of the clients to look at first.', facts: [], because: [] }] }), digest);
    expect(g.status).toBe('passed');
  });
});
