import { describe, expect, it } from 'vitest';
import {
  buildDigest, groundBriefing,
  type ClientCounts, type ClientRow, type Digest, type Fact, type PortfolioAction, type PortfolioAlert,
  type PortfolioOrganisation, type PortfolioView, type Submission, type SubmittedBlock,
} from '@/modules/portfolio';

/**
 * Phase 15 adviser-analyst evaluation (ADR-113, ADR-118).
 *
 * MODEL SELECTS, SERVER WRITES. The model answers with references — facts, MOTION's attention
 * reasons, alerts and actions, library phrases — and writes no text. These cases hold that
 * contract, including every sentence the two final audits reproduced, VERBATIM: each is submitted as
 * the model would try to — on its own, and right after a correct fact — and none may reach the
 * briefing. The model behind them is a fake: no live Claude model has been run (no API key).
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
const digest = buildDigest(view, [alertRow('al-1', 'Revenue issue 3'), alertRow('al-2', 'Issue 8')], [actionRow('ac-1', 'Follow up 12'), actionRow('ac-2', '3')]);

/** Facts a later digest could carry, as the server would state them. */
const REVENUE: Fact = { id: 'client:1/revenue_change', subject: 'client:1', organizationId: 'a', metric: 'revenue_change', type: 'percent_change', period: 'Sep 2026', value: '8', direction: 'decrease', source: 'test', statement: "Alpha Ltd's revenue fell 8% in Sep 2026" };
const RUNWAY: Fact = { id: 'client:1/cash_runway', subject: 'client:1', organizationId: 'a', metric: 'cash_runway', type: 'duration', period: 'Sep 2026', value: '3', direction: null, source: 'test', statement: "Alpha Ltd's cash runway at the end of Sep 2026 was 3 months" };
const B_REVENUE: Fact = { ...REVENUE, id: 'client:2/revenue_change', subject: 'client:2', organizationId: 'b', value: '2', statement: "Beta Ltd's revenue fell 2% in Sep 2026" };
const financial: Digest = { ...digest, facts: [...digest.facts, REVENUE, RUNWAY, B_REVENUE] };

const F = (...facts: string[]): SubmittedBlock => ({ kind: 'facts', facts });
const A = (...reasons: string[]): SubmittedBlock => ({ kind: 'attention', reasons });
const S = (ref: string): SubmittedBlock => ({ kind: 'source', ref });
const P = (phrase: string, ref?: string): SubmittedBlock => (ref === undefined ? { kind: 'phrase', phrase } : { kind: 'phrase', phrase, ref });
/** What a model might send in place of a reference: its own words. Never part of the contract. */
const X = (text: string): SubmittedBlock => ({ kind: 'text', text });

const submit = (partial: Partial<Submission>): Submission => ({
  mode: 'answer', headline: [P('look_first', 'client:1')], clients: [], notes: [], limitations: [], ...partial,
});
const summaryOf = (d: Digest, blocks: SubmittedBlock[], because: string[] = [], ref = 'client:1') => {
  const g = groundBriefing(submit({ clients: [{ ref, blocks, because }] }), d);
  return { ...g, summary: g.briefing.clients[0]!.summary };
};
const noteOf = (d: Digest, blocks: SubmittedBlock[]) => {
  const g = groundBriefing(submit({ notes: [{ blocks }] }), d);
  return { ...g, note: g.briefing.notes[0]?.text ?? null };
};

describe('the digest: facts, reasons and ranks the server holds', () => {
  it('each figure is a typed fact with its own sentence; each reason is citable; the queue order is MOTION\'s', () => {
    const byId = new Map(digest.facts.map((f) => [f.id, f]));
    expect(byId.get('client:1/health_score_change')).toMatchObject({ type: 'score_change', value: '23', direction: 'decrease', statement: "Alpha Ltd's health score fell 23 points, from 61 in Jul 2026 to 38 in Aug 2026" });
    expect(byId.get('portfolio/open_actions')?.statement).toBe('12 actions are open across the portfolio');
    expect(digest.clients[0]!.attention.map((r) => r.id)).toEqual(['client:1/attention/critical_alert', 'client:1/attention/health_band_fell']);
    expect(digest.clients.map((c) => c.attentionRank)).toEqual([1, null]);
  });

  it('a title is a source, never a fact', () => {
    expect(digest.facts.every((f) => !/Revenue issue|Issue 8|Follow up/.test(f.statement))).toBe(true);
  });
});

describe('the model writes no text: every audited sentence, verbatim, is discarded (F-1, F-2, F-4)', () => {
  // The final release audit of 33a182f (docs/PHASE_15_FINAL_RELEASE_AUDIT.md), as reproduced there.
  const AUDIT_1 = [
    '12 clients need attention.', '12 of 12 clients need attention.', '12 clients are healthy.', '12 clients are at risk.',
    '12 clients have critical alerts.', '3 clients have critical alerts.', '11 clients have open actions.',
    'Acme Trading completed 8 actions.', 'Acme Trading resolved 3 critical alerts.', '3 clients need attention.',
    'Its health score rose from 38 to 61.', 'Its health score rose from 38 in Jul 2026 to 61 in Aug 2026.',
    'FA Alpha has 1 critical alert as well as 3 high alerts.', 'Revenue fell 14% as well as margin at 8%.',
    'Alpha Ltd has a couple of critical alerts.', 'Alpha Ltd has a pair of critical alerts.', 'Alpha Ltd has a single critical alert.',
    'Alpha Ltd has a dozen overdue actions.', "None of Alpha Ltd's actions are overdue.", 'Alpha Ltd does not have any critical alerts.',
    'Both clients need attention.', 'All clients are healthy.', 'Alpha Ltd has III critical alerts.', 'Alpha Ltd has ٥ critical alerts.',
    'Its health fell for the third consecutive month.',
  ];
  // The final release audit of 48f2c4f (docs/PHASE_15_FINAL_RELEASE_AUDIT_2.md): prose after a fact.
  const AUDIT_2_ATTACHED: Array<[string, string]> = [
    ['client:1/open_actions', 'They are overdue.'],
    ['client:1/critical_alerts', 'They have been resolved.'],
    ['client:1/critical_alerts', 'They are not critical.'],
    ['client:1/previous_health_score', 'That is its latest score.'],
    ['client:1/health_score_change', 'Its health has improved.'],
    ['client:1/health_score', 'Its health is recovering.'],
    ['client:1/critical_alerts', 'Alpha Ltd has more open actions than critical alerts.'],
    ['client:1/open_actions', 'Alpha Ltd does not have any critical alerts.'],
  ];
  const AUDIT_2_ALONE = [
    'Only one of the clients needs attention.', 'Not one of the clients has overdue work.', 'Only one of its actions is overdue.',
    'Just one of the clients needs attention.', 'Alpha Ltd lacks critical alerts.', 'Alpha Ltd is free of critical alerts.',
    'It has twentyfive alerts.', 'It has tweny alerts.', 'It has eig­ht alerts.', 'It has eig​ht alerts.', 'It has iii alerts.',
    'Il y a vingt alertes.', 'Es gibt zwei Warnungen.', 'It has a quartet of alerts.', 'It has the lowest health score in the portfolio.',
    'Most actions are overdue.', 'Beta Ltd has a single overdue action to chase.', 'Cash pressure is increasing.',
    'Cash pressure is increasing by one third.', 'Cash pressure doubled.',
  ];

  it.each(AUDIT_1)('"%s" never reaches the briefing', (sentence) => {
    for (const blocks of [[X(sentence)], [F('client:1/critical_alerts'), X(sentence)]]) {
      const g = summaryOf(digest, blocks);
      expect(g.status).toBe('degraded');
      expect(g.summary).not.toContain(sentence);
    }
    expect(noteOf(digest, [X(sentence)]).note).toBeNull();
  });

  it('the exact F-4 sentence the previous test had altered: "Alpha Ltd does not have any critical alerts."', () => {
    const g = summaryOf(digest, [X('Alpha Ltd does not have any critical alerts.')]);
    expect(g.status).toBe('degraded');
    expect(g.summary).toBe('Alpha Ltd: 8 critical alerts; Health fell from Stable to At risk.');
  });

  it.each(AUDIT_2_ATTACHED)('after %s, "%s" is not rendered — only the server\'s sentence is', (fact, sentence) => {
    const g = summaryOf(digest, [F(fact), X(sentence)]);
    expect(g.status).toBe('degraded');
    expect(g.summary).toBe(summaryOf(digest, [F(fact)]).summary);
    expect(g.summary).not.toContain(sentence);
  });

  it.each(AUDIT_2_ALONE)('"%s" is not rendered', (sentence) => {
    const g = summaryOf(digest, [X(sentence)]);
    expect(g.status).toBe('degraded');
    expect(g.summary).not.toContain(sentence);
  });

  it('brief §21: "Alpha Ltd has 3 open actions." then "They are overdue." — the attachment is not rendered', () => {
    const g = summaryOf(digest, [F('client:1/open_actions'), X('They are overdue.')]);
    expect(g.summary).toBe('Alpha Ltd has 3 open actions.');
    // What IS true about overdue work is its own fact.
    expect(summaryOf(digest, [F('client:1/open_actions'), F('client:1/overdue_actions')]).summary).toBe('Alpha Ltd has 3 open actions. Alpha Ltd has 1 overdue action.');
  });

  it('brief §21: the July score then "That was the latest score." — not rendered; the latest is its own fact', () => {
    const g = summaryOf(digest, [F('client:1/previous_health_score'), X('That was the latest score.')]);
    expect(g.summary).toBe("Alpha Ltd's health score for Jul 2026 was 61.");
    expect(summaryOf(digest, [F('client:1/previous_health_score', 'client:1/health_score')]).summary)
      .toBe("Alpha Ltd's health score for Jul 2026 was 61. Alpha Ltd's health score for Aug 2026 is 38 (At risk).");
  });
});

describe('brief §22 — model misbehaviour', () => {
  it('A. a correct fact id with fabricated text: the text is discarded', () => {
    const g = summaryOf(digest, [{ kind: 'facts', facts: ['client:1/open_actions'], text: 'They are all overdue.' }]);
    expect(g.summary).toBe('Alpha Ltd has 3 open actions.');
    expect(g.status).toBe('degraded');
  });

  it('B. a fact id with a fabricated value: the value is ignored, the server\'s is rendered', () => {
    const g = summaryOf(digest, [{ kind: 'facts', facts: ['client:1/open_actions'], value: 5 }]);
    expect(g.summary).toBe('Alpha Ltd has 3 open actions.');
    expect(g.status).toBe('degraded');
  });

  it('C. a fact id with wrong-metric text: ignored', () => {
    const g = summaryOf(digest, [{ kind: 'facts', facts: ['client:1/open_actions'], metric: 'clients needing attention' }]);
    expect(g.summary).toBe('Alpha Ltd has 3 open actions.');
  });

  it('D. a foreign fact id is rejected', () => {
    const g = summaryOf(financial, [F('client:2/revenue_change')]);
    expect(g.status).toBe('degraded');
    expect(g.summary).not.toContain('Beta Ltd');
  });

  it('E. an unsupported block type is rejected', () => {
    for (const block of [{ kind: 'commentary', text: 'x' }, { kind: 'number', value: 12 }, { kind: 'text', text: 'Alpha needs attention.' }]) {
      const g = summaryOf(digest, [block]);
      expect(g.status).toBe('degraded');
    }
  });

  it('F. a fact block plus arbitrary adjacent text: only the server-rendered fact survives', () => {
    const g = summaryOf(digest, [X('Here is the key figure:'), F('client:1/critical_alerts'), X('— all resolved.')]);
    expect(g.summary).toBe('Alpha Ltd has 8 standing critical alerts.');
  });
});

describe('brief §5 / §23 — compound facts and ordering (F-3)', () => {
  it('the server attaches each value to its own noun, in whatever order the ids arrive', () => {
    expect(summaryOf(digest, [F('client:1/critical_alerts', 'client:1/open_actions')]).summary).toBe('Alpha Ltd has 8 standing critical alerts and 3 open actions.');
    expect(summaryOf(digest, [F('client:1/open_actions', 'client:1/critical_alerts')]).summary).toBe('Alpha Ltd has 3 open actions and 8 standing critical alerts.');
  });

  it('block order is preserved; no value moves between facts', () => {
    const g = summaryOf(digest, [F('client:1/health_score_change'), F('client:1/critical_alerts'), P('look_first')]);
    expect(g.summary).toBe("Alpha Ltd's health score fell 23 points, from 61 in Jul 2026 to 38 in Aug 2026. Alpha Ltd has 8 standing critical alerts. Look at Alpha Ltd first.");
    expect(g.status).toBe('passed');
  });
});

describe('brief §6 — the health change is the server\'s, direction and periods included (F-2)', () => {
  it('a fall renders "fell"; a rise renders "rose" — from the data, never the model', () => {
    const rising: ClientRow = { ...alpha, health: { ...alpha.health!, score: 61, previous: { ...alpha.health!.previous!, score: 38 } } };
    const d = buildDigest({ ...view, clients: [rising, beta] }, [], []);
    expect(summaryOf(digest, [F('client:1/health_score_change')]).summary).toBe("Alpha Ltd's health score fell 23 points, from 61 in Jul 2026 to 38 in Aug 2026.");
    expect(summaryOf(d, [F('client:1/health_score_change')]).summary).toBe("Alpha Ltd's health score rose 23 points, from 38 in Jul 2026 to 61 in Aug 2026.");
  });
});

describe('brief §9 / §12 — every claim is its own fact; a fact of another metric, period or organisation cannot stand in', () => {
  it('"Revenue declined 8%" and "Runway is 3 months" are the server\'s; "3%" and "8 months" cannot be written', () => {
    expect(summaryOf(financial, [F(REVENUE.id, RUNWAY.id)]).summary).toBe("Alpha Ltd's revenue fell 8% in Sep 2026. Alpha Ltd's cash runway at the end of Sep 2026 was 3 months.");
    for (const s of ['Revenue declined 3%.', 'Runway is 8 months.']) {
      const g = summaryOf(financial, [F(REVENUE.id), X(s)]);
      expect(g.status).toBe('degraded');
      expect(g.summary).toBe("Alpha Ltd's revenue fell 8% in Sep 2026.");
    }
  });

  it('forged, foreign and unissued fact ids fail; the valid ones in the same block still render', () => {
    const g = summaryOf(financial, [F(REVENUE.id, 'client:2/revenue_change', 'client:1/revenue_change_jul', 'client:1/made_up')]);
    expect(g.status).toBe('degraded');
    expect(g.summary).toBe("Alpha Ltd's revenue fell 8% in Sep 2026.");
    expect(g.removed).toEqual(expect.arrayContaining([
      'client:1 block 0: cites client:2/revenue_change, a fact about client:2',
      'client:1 block 0: cites client:1/revenue_change_jul, not a fact the digest issued',
    ]));
  });

  it('a note may state any client\'s fact, and the server names the client', () => {
    expect(noteOf(financial, [F(B_REVENUE.id)]).note).toBe("Beta Ltd's revenue fell 2% in Sep 2026.");
  });
});

describe('phrases: fixed wording, and only when the data says so', () => {
  it('"look first" only for the client MOTION ranks first; "needs attention" only when it does', () => {
    expect(summaryOf(digest, [P('look_first')]).status).toBe('passed');
    expect(summaryOf(digest, [P('look_first')], [], 'client:2').status).toBe('degraded');
    expect(summaryOf(digest, [P('needs_attention')], [], 'client:2').status).toBe('degraded');
    expect(summaryOf(digest, [P('client_clear')], [], 'client:2').summary).toBe('Nothing at Beta Ltd needs attention.');
    expect(summaryOf(digest, [P('client_clear')]).status).toBe('degraded');
    expect(noteOf(digest, [P('portfolio_clear')]).status).toBe('degraded');
  });

  it('"health unavailable" only for a client with no score; a phrase not in the library is rejected', () => {
    expect(summaryOf(digest, [P('health_unavailable')], [], 'client:2').summary).toBe('Beta Ltd has not been scored yet, so its health is not available.');
    expect(summaryOf(digest, [P('health_unavailable')]).status).toBe('degraded');
    expect(summaryOf(digest, [P('cash_pressure_rising')]).status).toBe('degraded');
  });

  it('a summary\'s phrase is about its own client, whatever ref the model sends', () => {
    expect(summaryOf(digest, [P('needs_attention', 'client:2')]).status).toBe('degraded');
  });
});

describe('attention reasons and sources are the server\'s words', () => {
  it('an attention block renders MOTION\'s own reason labels', () => {
    const g = summaryOf(digest, [A('client:1/attention/critical_alert', 'client:1/attention/health_band_fell')]);
    expect(g.summary).toBe('Alpha Ltd: 8 critical alerts; Health fell from Stable to At risk.');
    expect(summaryOf(digest, [A('client:1/attention/overdue_action')]).status).toBe('degraded');
  });

  it('brief §11: a source is shown as a quoted title with its standing; its number grounds nothing', () => {
    const g = summaryOf(digest, [S('alert:1'), S('action:2')]);
    expect(g.summary).toBe('Alpha Ltd: alert “Revenue issue 3” (critical, open). Alpha Ltd: action “3” (high priority).');
    expect(g.briefing.clients[0]!.because).toEqual(['alert:1', 'action:2']);
    expect(g.briefing.clients[0]!.facts).toEqual([]);
    // The title's 3 cannot be used to state anything.
    expect(summaryOf(digest, [S('alert:1'), X('Revenue declined 3%.')]).status).toBe('degraded');
    // Another client's source is refused.
    expect(summaryOf(digest, [S('alert:1')], [], 'client:2').status).toBe('degraded');
  });
});

describe('a well-behaved answer reads naturally and is Grounded', () => {
  it('headline, summary, note and limitation — every sentence the server\'s', () => {
    const g = groundBriefing(submit({
      headline: [F('portfolio/needing_attention'), P('look_first', 'client:1')],
      clients: [
        { ref: 'client:1', blocks: [F('client:1/critical_alerts', 'client:1/open_actions'), F('client:1/health_score_change'), A('client:1/attention/health_band_fell'), S('alert:2'), P('look_first')], because: ['action:1'] },
        { ref: 'client:2', blocks: [F('client:2/open_actions'), P('health_unavailable'), P('client_clear')], because: [] },
      ],
      notes: [{ blocks: [F('portfolio/open_actions', 'portfolio/overdue_actions')] }],
      limitations: ['figures_elsewhere'],
    }), digest);
    expect(g.removed).toEqual([]);
    expect(g.status).toBe('passed');
    expect(g.briefing.headline.text).toBe('1 client needs attention. Look at Alpha Ltd first.');
    expect(g.briefing.clients[0]!.summary).toBe(
      "Alpha Ltd has 8 standing critical alerts and 3 open actions. Alpha Ltd's health score fell 23 points, from 61 in Jul 2026 to 38 in Aug 2026. Alpha Ltd: Health fell from Stable to At risk. Alpha Ltd: alert “Issue 8” (critical, open). Look at Alpha Ltd first.",
    );
    expect(g.briefing.clients[0]!.because).toEqual(['action:1', 'alert:2']);
    expect(g.briefing.clients[1]!.summary).toBe('Beta Ltd has 9 open actions. Beta Ltd has not been scored yet, so its health is not available. Nothing at Beta Ltd needs attention.');
    expect(g.briefing.notes[0]!.text).toBe('12 actions are open across the portfolio. 1 open action is overdue across the portfolio.');
    expect(g.briefing.limitations).toEqual(["Financial figures beyond counts and health scores are not in this briefing; each client's own pages hold them."]);
  });

  it('scope: the model cannot introduce a client, nor cite another client\'s alert', () => {
    const g = groundBriefing(submit({ clients: [
      { ref: 'client:3', blocks: [P('needs_attention')], because: [] },
      { ref: 'client:2', blocks: [P('client_clear')], because: ['alert:1'] },
    ] }), digest);
    expect(g.briefing.clients.map((c) => c.ref)).toEqual(['client:2']);
    expect(g.briefing.clients[0]!.because).toEqual([]);
    expect(g.status).toBe('degraded');
  });

  it('a refusal is one library phrase, and nothing else is kept', () => {
    const g = groundBriefing(submit({ mode: 'refusal', headline: [F('portfolio/clients'), P('outside_scope')], clients: [{ ref: 'client:1', blocks: [], because: [] }] }), digest);
    expect(g.status).toBe('not_applicable');
    expect(g.briefing.headline.text).toBe('That is outside what the Command Centre can answer.');
    expect(g.briefing.clients).toEqual([]);
  });

  it('an empty headline becomes the server\'s count sentence; an emptied summary, the attention reasons', () => {
    const g = groundBriefing(submit({ headline: [X('Two clients.')], clients: [{ ref: 'client:1', blocks: [X('It has a dozen alerts.')], because: [] }] }), digest);
    expect(g.briefing.headline.text).toBe('1 client needs attention. The portfolio has 2 clients.');
    expect(g.briefing.clients[0]!.summary).toBe('Alpha Ltd: 8 critical alerts; Health fell from Stable to At risk.');
    expect(g.status).toBe('degraded');
  });

  it('a limitation is a library phrase; free text there is discarded', () => {
    const g = groundBriefing(submit({ limitations: ['Revenue is down forty percent but we cannot see why.', 'not_in_portfolio', 'look_first'] }), digest);
    expect(g.briefing.limitations).toEqual(['The organisation asked about is not in this portfolio.']);
    expect(g.status).toBe('degraded');
  });
});
