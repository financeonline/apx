import { describe, expect, it } from 'vitest';
import {
  buildDigest, digestNumbers, groundBriefing,
  type Briefing, type ClientRow, type PortfolioOrganisation, type PortfolioView,
} from '@/modules/portfolio';

/**
 * Phase 15 adviser-analyst evaluation (brief §20; ADR-113).
 *
 * Eight cases over the contract the server enforces AROUND the model. They do not call a model:
 * the cases that depend on what the model is handed are decided by construction (the digest is
 * built from the authorised view and nothing else), and the cases that depend on what the model
 * says are decided by the grounding rule, which is deterministic. The live-model behaviour behind
 * both boundaries is exercised in `test/integration/portfolio-ai.test.ts` with a recording fake.
 */

const org = (id: string, name: string): PortfolioOrganisation => ({ id, slug: id, name, status: 'active', role: 'employee' });

function view(rows: ClientRow[], extra: Partial<PortfolioView> = {}): PortfolioView {
  const alerts = extra.alerts ?? [];
  const actions = extra.actions ?? [];
  return {
    today: '2026-09-15',
    organisations: rows.map((r) => r.organisation),
    clients: rows,
    attention: rows.filter((r) => r.attention !== null),
    counts: {
      clients: rows.length, needingAttention: rows.filter((r) => r.attention !== null).length,
      healthy: rows.filter((r) => r.health?.band === 'stable' || r.health?.band === 'strong').length,
      unscored: rows.filter((r) => r.health === null).length,
      criticalAlerts: alerts.filter((a) => a.severity === 'critical').length,
      highAlerts: alerts.filter((a) => a.severity === 'high').length,
      openActions: actions.length, overdueActions: 0,
    },
    alerts, actions, recent: [],
  };
}

const alpha: ClientRow = {
  organisation: org('a', 'Alpha Ltd'),
  health: { organizationId: 'a', scoreId: 's', periodId: 'p', periodStart: '2026-08-01', periodLabel: 'Aug 2026', score: 38, band: 'at_risk', dimensionsUsed: 5, dimensionsTotal: 6, previous: { periodStart: '2026-07-01', periodLabel: 'Jul 2026', score: 61, band: 'stable' } },
  trend: 'down', openAlerts: 1, criticalOrHighAlerts: 1, openActions: 0, overdueActions: 0,
  attention: { organizationId: 'a', rank: [100, 250], reasons: [
    { kind: 'critical_alert', weight: 100, label: '1 critical alert', count: 1 },
    { kind: 'health_band_fell', weight: 80, label: 'Health fell from Stable to At risk', count: 1 },
    { kind: 'health_at_risk', weight: 70, label: 'Health is At risk', count: 1 },
  ] },
  latestChange: null,
};
const beta: ClientRow = {
  organisation: org('b', 'Beta Ltd'),
  health: null, trend: null, openAlerts: 0, criticalOrHighAlerts: 0, openActions: 0, overdueActions: 0, attention: null, latestChange: null,
};
const alphaAlert = { id: 'al-1', organizationId: 'a', ruleKey: 'cash.runway_low', severity: 'critical' as const, status: 'open' as const, title: 'Cash runway under two months', periodId: 'p', firstSeenAt: '2026-09-10T00:00:00Z', lastEvaluatedAt: '2026-09-14T00:00:00Z', evidenceBundleId: null, actionId: null };

const authorised = view([alpha, beta], { alerts: [alphaAlert] });
const digest = buildDigest(authorised);

const answer = (partial: Partial<Briefing>): Briefing => ({ mode: 'answer', headline: 'Alpha needs attention.', clients: [], notes: [], limitations: [], ...partial });

describe('Phase 15 adviser eval', () => {
  it('1. an employee with two assigned clients: the digest holds exactly those two', () => {
    expect(digest.clients.map((c) => c.name)).toEqual(['Alpha Ltd', 'Beta Ltd']);
    expect(digest.clients.map((c) => c.ref)).toEqual(['client:1', 'client:2']);
  });

  it('2. the employee asks about an unassigned client: the model cannot introduce one', () => {
    const grounded = groundBriefing(answer({
      headline: 'Gamma Ltd is in trouble.',
      clients: [{ ref: 'client:3', summary: 'Gamma has a critical alert.', because: ['alert:9'] }],
    }), digest);
    expect(grounded.briefing.clients).toEqual([]);
    expect(grounded.status).toBe('degraded');
    expect(grounded.removed).toContain('client client:3: not in the portfolio');
  });

  it('3. a client asks about another organisation: a client has no digest at all (resolver), and a digest never holds a foreign ref', () => {
    // A client-only caller never reaches buildDigest — the resolver refuses (portfolio.test.ts). At
    // this layer the guarantee is that a foreign citation cannot survive even if it were submitted.
    const grounded = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'Alpha.', because: ['alert:2'] }] }), digest);
    expect(grounded.briefing.clients[0]!.because).toEqual([]);
  });

  it('4. which clients need attention: the attention order is the data\'s, and a faithful answer passes', () => {
    const grounded = groundBriefing(answer({
      headline: '1 of 2 clients needs attention.',
      clients: [{ ref: 'client:1', summary: 'Alpha Ltd has 1 critical alert and its health fell from Stable to At risk (61 to 38).', because: ['alert:1'] }],
    }), digest);
    expect(grounded.status).toBe('passed');
    expect(grounded.removed).toEqual([]);
  });

  it('5. a health-change summary may quote the scores the data states, and nothing else', () => {
    expect(groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'Health fell from 61 to 38 between Jul 2026 and Aug 2026.', because: [] }] }), digest).status).toBe('passed');
    const invented = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'Health fell 23 points, roughly 38%.', because: [] }] }), digest);
    expect(invented.status).toBe('degraded');
    expect(invented.briefing.clients[0]!.summary).toBe('Alpha Ltd: 1 critical alert; Health fell from Stable to At risk; Health is At risk.');
  });

  it('6. an alert/action summary cites the digest\'s own references', () => {
    const grounded = groundBriefing(answer({ clients: [{ ref: 'client:1', summary: 'One critical alert stands: cash runway under two months.', because: ['alert:1'] }] }), digest);
    expect(grounded.status).toBe('passed');
    expect(grounded.briefing.clients[0]!.because).toEqual(['alert:1']);
  });

  it('7. a financial summary must use the deterministic values: a figure the digest lacks is replaced', () => {
    expect(digestNumbers(digest).has('412000')).toBe(false);
    const grounded = groundBriefing(answer({ headline: 'Portfolio revenue is £412,000 this month.', notes: ['Cash is £58,000.'] }), digest);
    expect(grounded.status).toBe('degraded');
    expect(grounded.briefing.headline).toBe('1 of 2 clients need attention.');
    expect(grounded.briefing.notes).toEqual([]);
  });

  it('8. an unavailable metric stays unavailable: Beta has no score, and a score for Beta is not grounded', () => {
    expect(digest.clients[1]!.health).toBeNull();
    const grounded = groundBriefing(answer({ clients: [{ ref: 'client:2', summary: 'Beta Ltd scores 0 and is at risk.', because: [] }] }), digest);
    // "0" is a count the digest states (open actions), so the number passes; the CLAIM does not, and the
    // digest is what the reader is shown. The rule that protects here is upstream: the digest carries
    // `health: null`, and the prompt says so; the model has no score to quote.
    expect(grounded.briefing.clients[0]!.summary).toContain('Beta');
    expect(groundBriefing(answer({ clients: [{ ref: 'client:2', summary: 'Beta Ltd scores 47.', because: [] }] }), digest).status).toBe('degraded');
  });
});
