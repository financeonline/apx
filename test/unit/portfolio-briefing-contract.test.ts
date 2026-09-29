import { describe, expect, it } from 'vitest';
import {
  PHRASES, SubmissionSchema, buildDigest, groundBriefing, phrasesForModel, renderFacts,
  type ClientCounts, type ClientRow, type PortfolioView, type SubmittedBlock,
} from '@/modules/portfolio';

/**
 * The structured briefing contract (ADR-118): what the model may send, and what the server does with
 * anything else. The adversarial matrix lives in `test/eval/portfolio-eval.test.ts`; this suite holds
 * the contract's mechanics — one bad block never fails the turn, every block is read strictly by its
 * kind, and the phrase library cannot state a quantity.
 */

const zero: ClientCounts = { alertsStanding: 0, alertsCritical: 0, alertsHigh: 0, actionsOpen: 0, actionsOverdue: 0, actionsDueSoon: 0, actionsUrgent: 0, actionsUrgentOnTime: 0, actionsMine: 0 };
const alpha: ClientRow = {
  organisation: { id: 'a', slug: 'a', name: 'Alpha Ltd', status: 'active', role: 'owner' }, health: null, trend: null,
  counts: { ...zero, alertsStanding: 2, alertsCritical: 2, actionsOpen: 4 },
  attention: { organizationId: 'a', rank: [100, 100], reasons: [{ kind: 'critical_alert', weight: 100, label: '2 critical alerts', count: 2 }] },
  latestChange: null,
};
const view: PortfolioView = {
  today: '2026-09-15', organisations: [alpha.organisation], clients: [alpha], attention: [alpha],
  counts: { clients: 1, needingAttention: 1, healthy: 0, unscored: 1, alertsStanding: 2, criticalAlerts: 2, highAlerts: 0, openActions: 4, overdueActions: 0, dueSoonActions: 0, urgentActions: 0, myActions: 0 },
  recent: [],
};
const digest = buildDigest(view, [], []);
const ground = (blocks: SubmittedBlock[]) => groundBriefing({ mode: 'answer', headline: [], clients: [{ ref: 'client:1', blocks, because: [] }], notes: [], limitations: [] }, digest);

describe('the forced tool\'s input', () => {
  it('accepts any block shape, so one bad block is judged by the grounder instead of failing the turn', () => {
    const parsed = SubmissionSchema.safeParse({
      mode: 'answer', headline: [{ kind: 'text', text: 'free words' }],
      clients: [{ ref: 'client:1', blocks: [{ kind: 'facts', facts: ['client:1/open_actions'], value: 9 }], because: [] }],
      notes: [], limitations: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('still refuses a submission that is not the contract at all', () => {
    expect(SubmissionSchema.safeParse({ mode: 'answer', headline: 'free words', clients: [], notes: [], limitations: [] }).success).toBe(false);
    expect(SubmissionSchema.safeParse({ mode: 'essay', headline: [], clients: [], notes: [], limitations: [] }).success).toBe(false);
  });
});

describe('each block is read strictly by its kind', () => {
  it.each([
    [{ kind: 'facts', facts: ['client:1/open_actions'], text: 'x' }, 'text'],
    [{ kind: 'facts', facts: ['client:1/open_actions'], value: 9 }, 'value'],
    [{ kind: 'attention', reasons: ['client:1/attention/critical_alert'], label: '9 alerts' }, 'label'],
    [{ kind: 'phrase', phrase: 'look_first', text: 'and quickly' }, 'text'],
    [{ kind: 'source', ref: 'alert:1', title: 'Made up' }, 'title'],
  ] as const)('%o: the extra field is discarded and the answer is degraded', (block, field) => {
    const g = ground([block]);
    expect(g.status).toBe('degraded');
    expect(g.removed.some((r) => r.includes(field))).toBe(true);
    expect(g.briefing.clients[0]!.summary).not.toMatch(/\b9\b|Made up|quickly|\bx\b/);
  });

  it.each([
    { kind: 'text', text: 'Alpha Ltd needs attention.' },
    { kind: 'commentary', text: 'Cash pressure is increasing.' },
    { kind: 'number', value: 12 },
    { kind: '' },
  ])('an unknown kind %o is discarded', (block) => {
    const g = ground([block]);
    expect(g.status).toBe('degraded');
    expect(g.briefing.clients[0]!.summary).toBe('Alpha Ltd: 2 critical alerts.');
  });

  it('malformed references reference nothing', () => {
    for (const block of [{ kind: 'facts', facts: 'client:1/open_actions' }, { kind: 'facts', facts: [12] }, { kind: 'facts' }, { kind: 'phrase' }, { kind: 'source' }, { kind: 'attention', reasons: {} }]) {
      expect(ground([block]).status, JSON.stringify(block)).toBe('degraded');
    }
  });

  it('a well-formed block is rendered and the answer passes', () => {
    const g = ground([{ kind: 'facts', facts: ['client:1/open_actions'] }, { kind: 'phrase', phrase: 'needs_attention' }]);
    expect(g.removed).toEqual([]);
    expect(g.briefing.clients[0]!.summary).toBe('Alpha Ltd has 4 open actions. Alpha Ltd needs attention.');
  });
});

describe('the phrase library', () => {
  it('states nothing quantitative and no period, in any of its phrases', () => {
    for (const p of phrasesForModel()) {
      expect(p.says, p.id).not.toMatch(/\p{N}|\b(?:one|two|three|all|every|none|no\s+\w+s|both|half|twice|month|quarter|year|week|today)\b/iu);
    }
    expect(phrasesForModel().map((p) => p.id).sort()).toEqual(Object.keys(PHRASES).sort());
  });

  it('is shown to the model with a placeholder, never a client\'s name', () => {
    expect(phrasesForModel().find((p) => p.id === 'look_first')).toEqual({ id: 'look_first', names_a_client: true, says: 'Look at {client} first.' });
  });
});

describe('renderFacts', () => {
  it('writes every word from the facts, and nothing when there are none', () => {
    const names = new Map([['client:1', 'Alpha Ltd']]);
    const facts = digest.facts.filter((f) => f.subject === 'client:1' && (f.metric === 'critical_alerts' || f.metric === 'open_actions'));
    expect(renderFacts(facts, names)).toBe('Alpha Ltd has 2 standing critical alerts and 4 open actions.');
    expect(renderFacts([], names)).toBe('');
  });
});
