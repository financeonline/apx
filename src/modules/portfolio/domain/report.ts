/**
 * The Portfolio Report (SOW §20 "Client reports", REQ-AD-08; ADR-149). Pure.
 *
 * One document over every client the caller advises, assembled from what the Command Centre
 * already shows — the aggregate's health, attention reasons and counts, and the advisory
 * opportunities — and nothing else. It adds no figure and no judgement: a client's line says what
 * the overview says about it, in the same order (attention queue first, then the rest by name).
 */

import { bandLabel, HEALTH_DISCLAIMER } from '@/modules/health';
import { TREND_LABELS } from './presentation';
import type { OpportunityEntry } from './opportunities';
import type { PortfolioCounts, PortfolioView } from './types';

export const PORTFOLIO_REPORT_VERSION = 'portfolio_report.v1';

export interface PortfolioReportClient {
  readonly organizationId: string;
  readonly name: string;
  readonly suspended: boolean;
  readonly health: {
    readonly score: number | null; readonly band: string | null; readonly periodLabel: string;
    readonly trend: string | null; readonly dimensionsUsed: number; readonly dimensionsTotal: number;
  } | null;
  readonly attention: readonly string[];
  readonly counts: {
    readonly criticalAlerts: number; readonly highAlerts: number; readonly alertsStanding: number;
    readonly openActions: number; readonly overdueActions: number;
  };
  readonly opportunities: ReadonlyArray<{ readonly title: string; readonly because: string; readonly suggestion: string }>;
}

export interface PortfolioReportContent {
  readonly version: typeof PORTFOLIO_REPORT_VERSION;
  readonly generatedAt: string;
  readonly today: string;
  readonly counts: PortfolioCounts;
  readonly clientsWithOpportunities: number;
  readonly clients: readonly PortfolioReportClient[];
  readonly disclaimer: string;
}

export function assemblePortfolioReport(
  view: PortfolioView, opportunities: readonly OpportunityEntry[], generatedAt: Date,
): PortfolioReportContent {
  const opportunitiesOf = new Map(opportunities.map((e) => [e.organizationId, e]));
  const attentionOrder = new Map(view.attention.map((row, index) => [row.organisation.id, index]));
  const rows = [...view.clients].sort((a, b) => {
    const ia = attentionOrder.get(a.organisation.id);
    const ib = attentionOrder.get(b.organisation.id);
    if (ia !== undefined || ib !== undefined) return (ia ?? Number.MAX_SAFE_INTEGER) - (ib ?? Number.MAX_SAFE_INTEGER);
    return a.organisation.name.localeCompare(b.organisation.name);
  });

  return {
    version: PORTFOLIO_REPORT_VERSION,
    generatedAt: generatedAt.toISOString(),
    today: view.today,
    counts: view.counts,
    clientsWithOpportunities: opportunities.length,
    clients: rows.map((row) => ({
      organizationId: row.organisation.id,
      name: row.organisation.name,
      suspended: row.organisation.status === 'suspended',
      health: row.health === null ? null : {
        score: row.health.score,
        band: bandLabel(row.health.band),
        periodLabel: row.health.periodLabel,
        trend: row.trend === null ? null : `${TREND_LABELS[row.trend]}${row.health.previous ? ` from ${row.health.previous.score ?? '—'} in ${row.health.previous.periodLabel}` : ''}`,
        dimensionsUsed: row.health.dimensionsUsed,
        dimensionsTotal: row.health.dimensionsTotal,
      },
      attention: row.attention?.reasons.map((r) => r.label) ?? [],
      counts: {
        criticalAlerts: row.counts.alertsCritical, highAlerts: row.counts.alertsHigh,
        alertsStanding: row.counts.alertsStanding, openActions: row.counts.actionsOpen,
        overdueActions: row.counts.actionsOverdue,
      },
      opportunities: (opportunitiesOf.get(row.organisation.id)?.opportunities ?? []).map((o) => ({
        title: o.title, because: o.because.join('; '), suggestion: o.suggestion,
      })),
    })),
    disclaimer: HEALTH_DISCLAIMER,
  };
}
