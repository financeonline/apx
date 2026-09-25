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

  it('6. quoting a cited alert title verbatim carries the title\'s own words', () => {
    const g = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'Cash runway under two months is the alert that stands.', facts: [], because: ['alert:1'] }] }), digest);
    expect(g.status).toBe('passed');
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
