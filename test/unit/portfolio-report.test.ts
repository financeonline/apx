import { describe, expect, it } from 'vitest';
import { assemblePortfolioReport, type OpportunityEntry, type PortfolioView } from '@/modules/portfolio';
import { renderPortfolioPdf } from '@/modules/reporting';

/**
 * The Portfolio Report (ADR-149): the overview's facts, assembled — attention queue first, then every
 * other client by name — with the opportunities beside each. Nothing new is worked out.
 */

const org = (id: string, name: string) => ({ id, slug: id, name, status: 'active' as const, role: 'owner' as const });
const zero = { alertsStanding: 0, alertsCritical: 0, alertsHigh: 0, actionsOpen: 0, actionsOverdue: 0, actionsDueSoon: 0, actionsUrgent: 0, actionsUrgentOnTime: 0, actionsMine: 0 };
const row = (id: string, name: string, attention: string | null, score: number | null) => ({
  organisation: org(id, name),
  health: score === null ? null : {
    organizationId: id, scoreId: `s-${id}`, periodId: 'p', periodStart: '2026-08-01', periodLabel: 'Aug 2026', score,
    band: score >= 60 ? 'stable' as const : 'needs_attention' as const, dimensionsUsed: 6, dimensionsTotal: 8,
    previous: { periodStart: '2026-07-01', periodLabel: 'Jul 2026', score: score + 12, band: 'stable' as const },
  },
  trend: score === null ? null : 'down' as const,
  counts: { ...zero, alertsStanding: attention ? 2 : 0, alertsCritical: attention ? 1 : 0 },
  attention: attention === null ? null : { organizationId: id, reasons: [{ kind: 'critical_alert' as const, weight: 100, label: attention, count: 1 }], rank: [100, 100] as const },
  latestChange: null,
});

const rows = [row('c', 'Charlie', null, 70), row('a', 'Alpha', '1 critical alert', 45), row('b', 'Bravo', null, null)];
const view = {
  today: '2026-09-15', organisations: rows.map((r) => r.organisation), clients: rows, attention: [rows[1]!],
  counts: { clients: 3, needingAttention: 1, healthy: 1, unscored: 1, alertsStanding: 2, criticalAlerts: 1, highAlerts: 0, openActions: 0, overdueActions: 0, dueSoonActions: 0, urgentActions: 0, myActions: 0 },
  recent: [],
} as unknown as PortfolioView;
const opportunities: OpportunityEntry[] = [{
  organizationId: 'c', periodLabel: 'Aug 2026', healthScoreId: 's-c', evidenceBundleId: null,
  opportunities: [{ kind: 'surplus_cash', title: 'Surplus cash', because: ['Cash would last 6 months or more', 'Profitability scores 70'], suggestion: 'Review how surplus cash is used.' }],
}];

describe('the portfolio report', () => {
  const report = assemblePortfolioReport(view, opportunities, new Date('2026-09-15T08:00:00Z'));

  it('puts the attention queue first, then every other client by name', () => {
    expect(report.clients.map((c) => c.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('says what the overview says about each client, and adds the opportunities', () => {
    const [alpha, bravo, charlie] = report.clients;
    expect(alpha).toMatchObject({ attention: ['1 critical alert'], counts: { criticalAlerts: 1, alertsStanding: 2 },
      health: { score: 45, band: 'Needs attention', trend: 'Falling from 57 in Jul 2026', dimensionsTotal: 8 } });
    expect(bravo!.health).toBeNull();
    expect(charlie!.opportunities).toEqual([{ title: 'Surplus cash', because: 'Cash would last 6 months or more; Profitability scores 70', suggestion: 'Review how surplus cash is used.' }]);
    expect(report).toMatchObject({ clientsWithOpportunities: 1, counts: { clients: 3, needingAttention: 1 }, version: 'portfolio_report.v1' });
  });

  it('renders as a PDF', async () => {
    const bytes = await renderPortfolioPdf(report);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
  });
});
