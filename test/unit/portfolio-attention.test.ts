import { describe, expect, it } from 'vitest';
import {
  REASON_WEIGHTS, SCORE_FALL_POINTS, adviserOrganisations, attentionEntry, attentionReasons, bandFell,
  compareAttention, scoreFell, trendOf,
  type PortfolioAction, type PortfolioAlert, type PortfolioHealth, type PortfolioOrganisation,
} from '@/modules/portfolio';

/**
 * The Command Centre's attention rules (ADR-112 §3). Pure: the same facts always give the same
 * queue, in the same order, because an adviser's morning must not depend on a model's mood.
 */

const org = (id: string, name = id, status: PortfolioOrganisation['status'] = 'active'): PortfolioOrganisation =>
  ({ id, slug: id, name, status, role: 'employee' });

const health = (score: number | null, previous: number | null = null): PortfolioHealth => ({
  organizationId: 'o', scoreId: 's', periodId: 'p', periodStart: '2026-08-01', periodLabel: 'Aug 2026',
  score, band: score === null ? null : score >= 80 ? 'strong' : score >= 60 ? 'stable' : score >= 40 ? 'needs_attention' : 'at_risk',
  dimensionsUsed: 6, dimensionsTotal: 6,
  previous: previous === null ? null : {
    periodStart: '2026-07-01', periodLabel: 'Jul 2026', score: previous,
    band: previous >= 80 ? 'strong' : previous >= 60 ? 'stable' : previous >= 40 ? 'needs_attention' : 'at_risk',
  },
});

const alert = (severity: PortfolioAlert['severity']): PortfolioAlert => ({
  id: `a-${severity}`, organizationId: 'o', ruleKey: 'cash.decline', severity, status: 'open', title: 't',
  periodId: 'p', firstSeenAt: '2026-08-02T00:00:00Z', lastEvaluatedAt: '2026-08-02T00:00:00Z',
  evidenceBundleId: null, actionId: null,
});

const action = (priority: PortfolioAction['priority'], dueDate: string | null): PortfolioAction => ({
  id: `x-${priority}-${dueDate}`, organizationId: 'o', title: 't', priority, status: 'open', ownerUserId: null,
  dueDate, sourceType: 'user', evidenceBundleId: null, createdAt: '2026-08-01T00:00:00Z',
  completedAt: null, updatedAt: '2026-08-01T00:00:00Z',
});

const TODAY = '2026-09-15';

describe('attention reasons come only from facts other modules established', () => {
  it('a clean client has no reason', () => {
    expect(attentionReasons({ organisation: org('a'), health: health(85, 84), alerts: [], actions: [], today: TODAY })).toEqual([]);
    expect(attentionEntry('a', [])).toBeNull();
  });

  it('counts critical and high alerts separately, and ignores medium and low', () => {
    const reasons = attentionReasons({
      organisation: org('a'), health: null, today: TODAY, actions: [],
      alerts: [alert('critical'), alert('critical'), alert('high'), alert('medium'), alert('low')],
    });
    expect(reasons.map((r) => [r.kind, r.count, r.label])).toEqual([
      ['critical_alert', 2, '2 critical alerts'],
      ['high_alert', 1, '1 high alert'],
    ]);
  });

  it("uses the Action Centre's own overdue rule and does not count an undated action as due", () => {
    const reasons = attentionReasons({
      organisation: org('a'), health: null, alerts: [], today: TODAY,
      actions: [action('medium', '2026-09-01'), action('critical', null), action('high', '2026-12-01'), action('low', null)],
    });
    expect(reasons.map((r) => [r.kind, r.count])).toEqual([['overdue_action', 1], ['urgent_action', 2]]);
  });

  it('reads health from the bands the Health Score wrote', () => {
    expect(bandFell(health(55, 65))).toBe(true);
    expect(bandFell(health(65, 55))).toBe(false);
    expect(scoreFell(health(62, 62 + SCORE_FALL_POINTS))).toBe(true);
    expect(scoreFell(health(62, 62 + SCORE_FALL_POINTS - 1))).toBe(false);
    // A fall across a band is the band reason, not both.
    expect(scoreFell(health(35, 75))).toBe(false);
    expect(attentionReasons({ organisation: org('a'), health: health(55, 65), alerts: [], actions: [], today: TODAY })
      .map((r) => r.kind)).toEqual(['health_band_fell', 'health_needs_attention']);
    expect(attentionReasons({ organisation: org('a'), health: health(30, 30), alerts: [], actions: [], today: TODAY })
      .map((r) => r.kind)).toEqual(['health_at_risk']);
    // No score is no health: not a reason, not a zero.
    expect(attentionReasons({ organisation: org('a'), health: health(null), alerts: [], actions: [], today: TODAY })).toEqual([]);
    expect(trendOf(health(null))).toBeNull();
    expect(trendOf(health(70, 60))).toBe('up');
    expect(trendOf(health(60, 70))).toBe('down');
    expect(trendOf(health(60, 60))).toBe('flat');
  });

  it('orders the queue by the heaviest reason, then the sum, then the name', () => {
    const a = attentionEntry('a', attentionReasons({ organisation: org('a', 'Beta'), health: health(30), alerts: [alert('high')], actions: [], today: TODAY }))!;
    const b = attentionEntry('b', attentionReasons({ organisation: org('b', 'Alpha'), health: null, alerts: [alert('critical')], actions: [], today: TODAY }))!;
    const c = attentionEntry('c', attentionReasons({ organisation: org('c', 'Gamma'), health: health(30), alerts: [alert('high')], actions: [action('low', '2026-01-01')], today: TODAY }))!;
    const d = attentionEntry('d', attentionReasons({ organisation: org('d', 'Alpha 2'), health: health(30), alerts: [alert('high')], actions: [], today: TODAY }))!;
    const sorted = [
      { entry: a, name: 'Beta' }, { entry: b, name: 'Alpha' }, { entry: c, name: 'Gamma' }, { entry: d, name: 'Alpha 2' },
    ].sort(compareAttention).map((x) => x.name);
    // b: one critical (100). c: at_risk 70 + high 50 + overdue 60 = 180, max 70. a and d: max 70, sum 120 → by name.
    expect(sorted).toEqual(['Alpha', 'Gamma', 'Alpha 2', 'Beta']);
    expect(b.rank).toEqual([REASON_WEIGHTS.critical_alert, REASON_WEIGHTS.critical_alert]);
  });
});

describe('who has a portfolio (ADR-112 §2)', () => {
  const row = (organizationId: string, role: string) => ({ organizationId, slug: organizationId, name: organizationId, status: 'active' as const, role });

  it('keeps adviser roles and drops a client membership, so a client-only caller has nothing', () => {
    expect(adviserOrganisations([row('a', 'client')])).toEqual([]);
    expect(adviserOrganisations([row('a', 'client'), row('b', 'owner')]).map((o) => o.id)).toEqual(['b']);
    expect(adviserOrganisations([row('c', 'employee'), row('a', 'super_admin'), row('b', 'admin')]).map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a suspended membership: a role that resolves to suspended_member advises nothing', () => {
    expect(adviserOrganisations([row('a', 'suspended_member'), row('b', 'none')])).toEqual([]);
  });
});
