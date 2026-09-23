import 'server-only';
import { isOverdue } from '@/modules/actions';
import { attentionEntry, attentionReasons, compareAttention, trendOf } from '../domain/attention';
import type {
  ClientRow, PortfolioAction, PortfolioAlert, PortfolioCounts, PortfolioHealth, PortfolioOrganisation,
  PortfolioView, RecentChange,
} from '../domain/types';
import * as repo from '../data/repository';
import type { PortfolioContext } from './access';

/** "Recent" on the Command Centre: the last seven days. */
export const RECENT_DAYS = 7;
/** The attention queue is a queue, not an archive. */
export const ATTENTION_CAP = 25;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

export function hrefs(org: PortfolioOrganisation) {
  return {
    home: `/app/${org.slug}/home`,
    alert: (alertId: string) => `/app/${org.slug}/insights/alerts/${alertId}`,
    action: (actionId: string) => `/app/${org.slug}/actions/${actionId}`,
    evidence: (bundleId: string) => `/app/${org.slug}/evidence/${bundleId}`,
    client: `/portfolio/clients/${org.id}`,
  };
}

/**
 * The whole Command Centre in five statements, whatever the client count (ADR-112 §4).
 *
 * Organisations come from the resolver (`api.my_organizations`), health from `health_current`,
 * alerts and actions from their own tables; every statement carries the authorised ids and runs
 * under RLS. What follows is counting and sorting in memory over a bounded set — no money is
 * summed and no figure is derived, because the portfolio reports what other modules established.
 */
export async function loadPortfolio(ctx: PortfolioContext): Promise<PortfolioView> {
  const now = ctx.now();
  const today = isoDay(now);
  const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString();
  const ids = ctx.organisationIds;

  const [health, alerts, actions, finished] = await Promise.all([
    repo.loadPortfolioHealth(ctx.db, ids, ctx.requestId),
    repo.loadStandingAlerts(ctx.db, ids, ctx.requestId),
    repo.loadOpenActions(ctx.db, ids, ctx.requestId),
    repo.loadRecentlyFinishedActions(ctx.db, ids, since, ctx.requestId),
  ]);

  const byOrg = <T extends { organizationId: string }>(rows: readonly T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) map.set(row.organizationId, [...(map.get(row.organizationId) ?? []), row]);
    return map;
  };
  const alertsByOrg = byOrg(alerts);
  const actionsByOrg = byOrg(actions);
  const finishedByOrg = byOrg(finished);

  const recent: RecentChange[] = [];
  const clients: ClientRow[] = ctx.organisations.map((organisation) => {
    const orgAlerts = alertsByOrg.get(organisation.id) ?? [];
    const orgActions = actionsByOrg.get(organisation.id) ?? [];
    const orgHealth = health.get(organisation.id) ?? null;
    const links = hrefs(organisation);

    const changes = recentChanges(organisation, orgHealth, orgAlerts, finishedByOrg.get(organisation.id) ?? [], since, links);
    recent.push(...changes);

    const reasons = attentionReasons({ organisation, health: orgHealth, alerts: orgAlerts, actions: orgActions, today });
    return {
      organisation,
      health: orgHealth,
      trend: trendOf(orgHealth),
      openAlerts: orgAlerts.length,
      criticalOrHighAlerts: orgAlerts.filter((a) => a.severity === 'critical' || a.severity === 'high').length,
      openActions: orgActions.length,
      overdueActions: orgActions.filter((a) => isOverdue(a, today)).length,
      attention: attentionEntry(organisation.id, reasons),
      latestChange: changes[0] ?? null,
    };
  });

  const attention = clients
    .filter((c): c is ClientRow & { attention: NonNullable<ClientRow['attention']> } => c.attention !== null)
    .sort((a, b) => compareAttention(
      { entry: a.attention, name: a.organisation.name },
      { entry: b.attention, name: b.organisation.name },
    ))
    .slice(0, ATTENTION_CAP);

  const counts: PortfolioCounts = {
    clients: clients.length,
    needingAttention: clients.filter((c) => c.attention !== null).length,
    healthy: clients.filter((c) => c.health?.band === 'stable' || c.health?.band === 'strong').length,
    unscored: clients.filter((c) => c.health === null || c.health.score === null).length,
    criticalAlerts: alerts.filter((a) => a.severity === 'critical').length,
    highAlerts: alerts.filter((a) => a.severity === 'high').length,
    openActions: actions.length,
    overdueActions: actions.filter((a) => isOverdue(a, today)).length,
  };

  recent.sort((a, b) => b.at.localeCompare(a.at));

  return {
    today,
    organisations: ctx.organisations,
    clients,
    attention,
    counts,
    alerts: sortAlerts(alerts),
    actions,
    recent: recent.slice(0, repo.RECENT_CAP),
  };
}

const SEVERITY_RANK: Record<PortfolioAlert['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** Worst first, then longest standing: the alert engine's own order (§8.3). */
export function sortAlerts(alerts: readonly PortfolioAlert[]): PortfolioAlert[] {
  return [...alerts].sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.firstSeenAt.localeCompare(b.firstSeenAt));
}

function recentChanges(
  organisation: PortfolioOrganisation,
  health: PortfolioHealth | null,
  alerts: readonly PortfolioAlert[],
  finished: readonly PortfolioAction[],
  since: string,
  links: ReturnType<typeof hrefs>,
): RecentChange[] {
  const out: RecentChange[] = [];
  for (const alert of alerts) {
    if (alert.firstSeenAt >= since) {
      out.push({ kind: 'alert_raised', organizationId: organisation.id, at: alert.firstSeenAt, label: alert.title, href: links.alert(alert.id) });
    }
  }
  for (const action of finished) {
    out.push({
      kind: action.status === 'completed' ? 'action_completed' : 'action_dismissed',
      organizationId: organisation.id,
      at: action.completedAt ?? action.updatedAt,
      label: action.title,
      href: links.action(action.id),
    });
  }
  // A month scored is a change too, but its instant is the period, which has no timestamp here;
  // the client row states the month instead. Nothing is invented.
  void health;
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
