import { describe, expect, it } from 'vitest';
import {
  buildDigest, groundBriefing,
  type ClientCounts, type ClientRow, type Digest, type Fact, type PortfolioAction, type PortfolioAlert,
  type PortfolioOrganisation, type PortfolioView, type Submission, type SubmittedStatement,
} from '@/modules/portfolio';

/**
 * Phase 15 adviser-analyst evaluation (ADR-113, ADR-116).
 *
 * The model does not write figures. It chooses facts by id; the server writes every figure from the
 * fact — value, noun, subject, period, direction — and removes any prose that carries a quantity.
 * These cases hold that contract. What the model is handed is decided by construction (the digest
 * is built from the authorised view); what an answer can say is decided here, deterministically.
 * The model behind both boundaries is a fake: no live Claude model has been run (no API key).
 */

const org = (id: string, name: string): PortfolioOrganisation => ({ id, slug: id, name, status: 'active', role: 'employee' });
const zero: ClientCounts = { alertsStanding: 0, alertsCritical: 0, alertsHigh: 0, actionsOpen: 0, actionsOverdue: 0, actionsDueSoon: 0, actionsUrgent: 0, actionsUrgentOnTime: 0, actionsMine: 0 };

const alpha: ClientRow = {
  organisation: org('a', 'Alpha Ltd'),
  health: { organizationId: 'a', scoreId: 's', periodId: 'p', periodStart: '2026-08-01', periodLabel: 'Aug 2026', score: 38, band: 'at_risk', dimensionsUsed: 5, dimensionsTotal: 6, previous: { periodStart: '2026-07-01', periodLabel: 'Jul 2026', score: 61, band: 'stable' } },
  trend: 'down',
  counts: { ...zero, alertsStanding: 8, alertsCritical: 8, actionsOpen: 3, actionsOverdue: 1 },
  attention: { organizationId: 'a', rank: [100, 250], reasons: [
    { kind: 'critical_alert', weight: 100, label: '8 critical alerts', count: 8 },
    { kind: 'health_band_fell', weight: 80, label: 'Health fell from Stable to At risk', count: 1 },
  ] },
  latestChange: null,
};
const beta: ClientRow = { organisation: org('b', 'Beta Ltd'), health: null, trend: null, counts: { ...zero, actionsOpen: 9 }, attention: null, latestChange: null };
const alertRow = (id: string, title: string): PortfolioAlert => ({ id, organizationId: 'a', ruleKey: 'cash.runway_low', severity: 'critical', status: 'open', title, periodId: 'p', firstSeenAt: '2026-09-10T00:00:00Z', lastEvaluatedAt: '2026-09-14T00:00:00Z', evidenceBundleId: null, actionId: null });
const actionRow = (id: string, title: string): PortfolioAction => ({ id, organizationId: 'a', title, priority: 'high', status: 'open', ownerUserId: null, dueDate: null, sourceType: 'manual', evidenceBundleId: null, createdAt: '2026-09-01T00:00:00Z', completedAt: null, updatedAt: '2026-09-01T00:00:00Z' });

const view: PortfolioView = {
  today: '2026-09-15',
  organisations: [alpha.organisation, beta.organisation],
  clients: [alpha, beta],
  attention: [alpha],
  counts: { clients: 2, needingAttention: 1, healthy: 0, unscored: 1, alertsStanding: 8, criticalAlerts: 8, highAlerts: 0, openActions: 12, overdueActions: 1, dueSoonActions: 0, urgentActions: 0, myActions: 0 },
  recent: [],
};
const digest = buildDigest(view, [alertRow('al-1', 'Revenue issue 3')], [actionRow('ac-1', 'Follow up 12')]);

/** Facts a later digest could carry, stated by the server exactly as these statements say. */
const REVENUE: Fact = { id: 'client:1/revenue_change', subject: 'client:1', organizationId: 'a', metric: 'revenue_change', type: 'percent_change', period: 'Sep 2026', value: '8', direction: 'decrease', source: 'test', statement: "Alpha Ltd's revenue fell 8% in Sep 2026" };
const RUNWAY: Fact = { id: 'client:1/cash_runway', subject: 'client:1', organizationId: 'a', metric: 'cash_runway', type: 'duration', period: 'Sep 2026', value: '1.5', direction: null, source: 'test', statement: "Alpha Ltd's cash runway at the end of Sep 2026 was 1.5 months" };
const COSTS: Fact = { id: 'client:1/cost_multiple', subject: 'client:1', organizationId: 'a', metric: 'cost_multiple', type: 'multiplier', period: 'Sep 2026', value: '2', direction: 'increase', source: 'test', statement: "Alpha Ltd's costs in Sep 2026 were 2 times those of Aug 2026" };
const B_REVENUE: Fact = { ...REVENUE, id: 'client:2/revenue_change', subject: 'client:2', organizationId: 'b', statement: "Beta Ltd's revenue fell 8% in Sep 2026" };
const financial: Digest = { ...digest, facts: [...digest.facts, REVENUE, RUNWAY, COSTS, B_REVENUE] };

const T = (text: string): SubmittedStatement => ({ kind: 'text', text });
const F = (...facts: string[]): SubmittedStatement => ({ kind: 'facts', facts });
const submit = (partial: Partial<Submission>): Submission => ({
  mode: 'answer', headline: [T('Alpha Ltd needs attention first.')], clients: [], notes: [], limitations: [], ...partial,
});
const summaryOf = (d: Digest, statements: SubmittedStatement[], because: string[] = []) => {
  const g = groundBriefing(submit({ clients: [{ ref: 'client:1', statements, because }] }), d);
  return { ...g, summary: g.briefing.clients[0]!.summary };
};
const noteOf = (d: Digest, statements: SubmittedStatement[]) => {
  const g = groundBriefing(submit({ notes: [{ statements }] }), d);
  return { ...g, note: g.briefing.notes[0]?.text ?? null };
};

describe('the digest: facts with their meaning, stated by the server', () => {
  it('holds exactly the assigned clients, each figure a typed fact with its own sentence', () => {
    expect(digest.clients.map((c) => c.name)).toEqual(['Alpha Ltd', 'Beta Ltd']);
    const byId = new Map(digest.facts.map((f) => [f.id, f]));
    expect(byId.get('client:1/health_score')).toMatchObject({ type: 'score', value: '38', period: 'Aug 2026', statement: "Alpha Ltd's health score for Aug 2026 is 38 (At risk)" });
    expect(byId.get('client:1/health_score_change')).toMatchObject({ type: 'score_change', value: '23', direction: 'decrease', statement: "Alpha Ltd's health score fell 23 points, from 61 in Jul 2026 to 38 in Aug 2026" });
    expect(byId.get('portfolio/open_actions')?.statement).toBe('12 actions are open across the portfolio');
    expect(byId.get('portfolio/needing_attention')?.statement).toBe('1 client needs attention');
    expect(digest.facts.some((f) => f.subject === 'client:2' && f.metric === 'health_score')).toBe(false);
  });

  it('a title is metadata: its numbers are in no fact', () => {
    expect(digest.facts.some((f) => f.value === '12' && f.metric !== 'open_actions')).toBe(false);
    expect(digest.facts.every((f) => !f.statement.includes('Revenue issue') && !f.statement.includes('Follow up'))).toBe(true);
  });
});

describe('scope and citations (ADR-113)', () => {
  it('the model cannot introduce a client', () => {
    const g = groundBriefing(submit({ clients: [{ ref: 'client:3', statements: [T('Gamma has a critical alert.')], because: ['alert:9'] }] }), digest);
    expect(g.briefing.clients).toEqual([]);
    expect(g.status).toBe('degraded');
    expect(g.removed).toContain('client client:3: not in the portfolio');
  });

  it('a citation of another client\'s alert is dropped', () => {
    const g = groundBriefing(submit({ clients: [{ ref: 'client:2', statements: [T('Beta Ltd is steady.')], because: ['alert:1'] }] }), digest);
    expect(g.briefing.clients[0]!.because).toEqual([]);
    expect(g.status).toBe('degraded');
  });

  it('a client summary cannot state another client\'s fact, and a fact the digest did not issue grounds nothing', () => {
    const g = summaryOf(financial, [F('client:2/open_actions', 'client:1/made_up')]);
    expect(g.status).toBe('degraded');
    expect(g.removed).toEqual(expect.arrayContaining([
      'client:1 statement 0: cites client:2/open_actions, a fact about client:2',
      'client:1 statement 0: cites client:1/made_up, not a fact the digest issued',
    ]));
    expect(g.summary).not.toContain('9 open');
  });

  it('a refusal carries no clients, no notes and no facts', () => {
    const g = groundBriefing(submit({ mode: 'refusal', headline: [F('portfolio/clients'), T('That is outside this portfolio.')], clients: [{ ref: 'client:1', statements: [], because: [] }] }), digest);
    expect(g.status).toBe('not_applicable');
    expect(g.briefing.headline.text).toBe('That is outside this portfolio.');
    expect(g.briefing.clients).toEqual([]);
  });

  it('an unavailable metric stays unavailable: Beta has no score fact, and prose cannot supply one', () => {
    expect(summaryOf(digest, [F('client:2/health_score')]).status).toBe('degraded');
    const g = groundBriefing(submit({ clients: [{ ref: 'client:2', statements: [T('Beta Ltd has a health score of zero.')], because: [] }] }), digest);
    expect(g.status).toBe('degraded');
    expect(g.briefing.clients[0]!.summary).toBe('Beta Ltd: nothing needs attention.');
  });
});

describe('brief §16 — the adversarial matrix', () => {
  it('1. a correct count is the server\'s sentence', () => {
    const g = noteOf(digest, [F('portfolio/open_actions')]);
    expect(g.status).toBe('passed');
    expect(g.note).toBe('12 actions are open across the portfolio.');
  });

  it('2. "12 clients need attention" cannot be said when 12 is the open-action count (F-1)', () => {
    const prose = noteOf(digest, [T('12 clients need attention.')]);
    expect(prose.status).toBe('degraded');
    expect(prose.note).toBeNull();
    // The only way to state the 12 is its own fact, which says what it measures.
    expect(noteOf(digest, [F('portfolio/open_actions')]).note).not.toMatch(/need attention/);
  });

  it('3. a correct percentage is the server\'s sentence', () => {
    const g = summaryOf(financial, [F(REVENUE.id)]);
    expect(g.status).toBe('passed');
    expect(g.summary).toBe("Alpha Ltd's revenue fell 8% in Sep 2026.");
  });

  it('4. wrong metric: "Cash fell 8%" cannot be written, and the 8% can only be stated as revenue', () => {
    expect(summaryOf(financial, [T('Cash fell 8%.')]).status).toBe('degraded');
    expect(summaryOf(financial, [F(REVENUE.id)]).summary).toMatch(/^Alpha Ltd's revenue/);
  });

  it('5. wrong period: prose cannot name a period at all (F-2)', () => {
    for (const s of ['Revenue declined 8% last month.', 'Revenue declined last month.', 'Its health score is lower this month.', 'Revenue fell in August.']) {
      expect(summaryOf(financial, [T(s)]).status, s).toBe('degraded');
    }
  });

  it('6. wrong direction: prose cannot state the change, and the fact states its own direction', () => {
    expect(summaryOf(financial, [T('Revenue increased 8%.')]).status).toBe('degraded');
    expect(summaryOf(financial, [F(REVENUE.id)]).summary).toContain('fell 8%');
    expect(summaryOf(digest, [F('client:1/health_score_change')]).summary).toBe("Alpha Ltd's health score fell 23 points, from 61 in Jul 2026 to 38 in Aug 2026.");
  });

  it('7. two facts in one sentence, each with its own noun', () => {
    const g = summaryOf(digest, [F('client:1/critical_alerts', 'client:1/open_actions')]);
    expect(g.status).toBe('passed');
    expect(g.summary).toBe('Alpha Ltd has 8 standing critical alerts and 3 open actions.');
  });

  it('8. swapped values cannot be expressed (F-3)', () => {
    expect(summaryOf(digest, [T('Alpha Ltd has 3 critical alerts and 8 open actions.')]).status).toBe('degraded');
    expect(summaryOf(digest, [T('Alpha Ltd has critical alerts as well as open actions.')]).status).toBe('passed');
    // Whatever order the ids come in, each value stays with its own noun.
    expect(summaryOf(digest, [F('client:1/open_actions', 'client:1/critical_alerts')]).summary).toBe('Alpha Ltd has 3 open actions and 8 standing critical alerts.');
  });

  it.each([
    ['9 number words', 'Revenue fell by twenty per cent.'],
    ['10 a fraction', 'Runway is one and a half months.'],
    ['11 a multiplier', 'Costs doubled.'],
    ['12 a dozen', 'It has a dozen overdue actions.'],
    ['13 a couple', 'It has a couple of critical alerts.'],
    ['14 a Roman numeral', 'It has III critical alerts.'],
    ['15 an Arabic-Indic numeral', 'It has ٥ critical alerts.'],
    ['18 unsupported quantitative prose', 'Portfolio revenue is £412,000.'],
  ])('%s is removed from prose', (_name, sentence) => {
    const g = summaryOf(financial, [T(sentence), T('Alpha Ltd needs attention first.')]);
    expect(g.status).toBe('degraded');
    expect(g.summary).toBe('Alpha Ltd needs attention first.');
  });

  it('11 (bis). a multiplier is stated only by a fact that states one', () => {
    expect(summaryOf(financial, [F(COSTS.id)]).summary).toBe("Alpha Ltd's costs in Sep 2026 were 2 times those of Aug 2026.");
  });

  it('16. a title containing a number grounds nothing (L-2)', () => {
    const g = summaryOf(digest, [T('Revenue declined 3%.')], ['alert:1']);
    expect(g.status).toBe('degraded');
    expect(g.briefing.clients[0]!.because).toEqual(['alert:1']);
    // Cited, the alert is shown by the page from its ref; the prose need not repeat its title.
    expect(summaryOf(digest, [T('The revenue alert is the one to act on.')], ['alert:1', 'action:1']).status).toBe('passed');
  });

  it('17. a number inside quoted metadata is still a number in prose', () => {
    expect(summaryOf(digest, [T('The alert “Revenue issue 3” stands.')], ['alert:1']).status).toBe('degraded');
    expect(summaryOf(digest, [T('The action "Follow up 12" is open.')], ['action:1']).status).toBe('degraded');
  });

  it('19. two valid quantitative claims of different kinds in one statement', () => {
    const g = summaryOf(financial, [F(REVENUE.id, RUNWAY.id)]);
    expect(g.status).toBe('passed');
    expect(g.summary).toBe("Alpha Ltd's revenue fell 8% in Sep 2026. Alpha Ltd's cash runway at the end of Sep 2026 was 1.5 months.");
  });

  it('20. one valid and one invalid claim: the valid one stands, the answer is not Grounded', () => {
    const facts = summaryOf(financial, [F(REVENUE.id, 'client:2/revenue_change')]);
    expect(facts.status).toBe('degraded');
    expect(facts.summary).toBe("Alpha Ltd's revenue fell 8% in Sep 2026.");
    const mixed = summaryOf(financial, [F(REVENUE.id), T('Runway is three months.')]);
    expect(mixed.status).toBe('degraded');
    expect(mixed.summary).toBe("Alpha Ltd's revenue fell 8% in Sep 2026.");
  });
});

describe('the final audit\'s F-1…F-4 cases, as the model could submit them', () => {
  it.each([
    'Twelve clients need attention.', '12 clients are healthy.', 'Alpha Ltd completed 8 actions.', 'It resolved 3 critical alerts.',
    'Its health score rose from 38 to 61.', 'Its current health score is 61.', 'Its health score slumped 2 points.',
    'It has 8 critical alerts as well as 3 open actions.', 'It has 1 critical alert as well as 3 high alerts.',
    'It has a single critical alert.', 'It has a pair of overdue actions.', 'None of its actions are overdue.',
    'It does not have any critical alerts... none.', 'Both clients need attention.', 'All clients are healthy.',
    'This is the third consecutive month of decline.', 'Revenue fell 20%-plus.', 'Revenue fell 3 per-cent.',
  ])('"%s" never reaches the answer', (sentence) => {
    const g = summaryOf(digest, [T(sentence)]);
    expect(g.status).toBe('degraded');
    expect(g.summary).not.toContain(sentence);
  });

  it('the wrong organisation cannot be named beside a figure: the server names the subject', () => {
    expect(noteOf(financial, [T('Beta Ltd revenue declined 8%.')]).status).toBe('degraded');
    expect(noteOf(financial, [F(REVENUE.id)]).note).toBe("Alpha Ltd's revenue fell 8% in Sep 2026.");
    expect(noteOf(financial, [F(B_REVENUE.id)]).note).toBe("Beta Ltd's revenue fell 8% in Sep 2026.");
  });

  it('a value cannot be altered: text sent with facts is never shown, and the value comes from the digest', () => {
    const g = summaryOf(digest, [{ kind: 'facts', facts: ['client:1/open_actions'], text: 'Alpha Ltd has 99 open actions' }]);
    expect(g.summary).toBe('Alpha Ltd has 3 open actions.');
    expect(g.removed).toContain('client:1 statement 0: text beside facts is never shown');
  });
});

describe('honest answers still pass (a check that fails correct answers gets switched off)', () => {
  it('qualitative prose and server-rendered facts together', () => {
    const g = groundBriefing(submit({
      headline: [F('portfolio/needing_attention', 'portfolio/clients'), T('Alpha Ltd needs attention first.')],
      clients: [{
        ref: 'client:1',
        statements: [
          F('client:1/critical_alerts', 'client:1/overdue_actions'),
          F('client:1/health_score_change'),
          T('Cash pressure is increasing, and several actions need an owner.'),
        ],
        because: ['alert:1', 'action:1'],
      }],
      notes: [{ statements: [T('One of the clients is at risk; look at Alpha Ltd first.')] }],
      limitations: ['Financial figures beyond counts and health scores are not in the data.'],
    }), digest);
    expect(g.removed).toEqual([]);
    expect(g.status).toBe('passed');
    expect(g.briefing.headline.text).toBe('1 client needs attention. The portfolio has 2 clients. Alpha Ltd needs attention first.');
    expect(g.briefing.clients[0]!.summary).toBe(
      "Alpha Ltd has 8 standing critical alerts and 1 overdue action. Alpha Ltd's health score fell 23 points, from 61 in Jul 2026 to 38 in Aug 2026. Cash pressure is increasing, and several actions need an owner.",
    );
    expect(g.briefing.clients[0]!.facts).toEqual(['client:1/critical_alerts', 'client:1/overdue_actions', 'client:1/health_score_change']);
  });

  it('an empty headline becomes the server\'s count sentence; an emptied summary, the attention reasons', () => {
    const g = groundBriefing(submit({ headline: [T('Two clients.')], clients: [{ ref: 'client:1', statements: [T('It has a dozen alerts.')], because: [] }] }), digest);
    expect(g.briefing.headline.text).toBe('1 client needs attention. The portfolio has 2 clients.');
    expect(g.briefing.clients[0]!.summary).toBe('Alpha Ltd: 8 critical alerts; Health fell from Stable to At risk.');
    expect(g.status).toBe('degraded');
  });

  it('a limitation is prose under the same rule', () => {
    const g = groundBriefing(submit({ limitations: ['Revenue is down forty percent but we cannot see why.', 'Cash figures are not in the data.'] }), digest);
    expect(g.briefing.limitations).toEqual(['Cash figures are not in the data.']);
    expect(g.status).toBe('degraded');
  });
});
